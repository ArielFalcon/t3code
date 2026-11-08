import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";
import {
  buildT3TaskPrompt,
  collectT3TaskBriefs,
  collectT3TaskFragments,
  humanizeT3TaskId,
  stripT3TaskBriefs,
  stripT3TaskMarkers,
  withStreamingT3TaskMarkers,
} from "./taskMarkers.ts";

interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly tagName?: string;
  readonly properties?: Record<string, unknown>;
  readonly children?: readonly HastNode[];
}

/** Text of the sanitized tree with each task fragment shown as `{id:text}`. */
function rendered(markdown: string, plugins = CHAT_MARKDOWN_REMARK_PLUGINS): string {
  const processor = unified()
    .use(remarkParse)
    .use(plugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const text = (node: HastNode): string => {
    if (node.type === "text") return node.value ?? "";
    const inner = (node.children ?? []).map(text).join("");
    const id = node.properties?.dataT3Task;
    return typeof id === "string" ? `{${id}:${inner}}` : inner;
  };
  return text(processor.runSync(processor.parse(markdown), markdown) as HastNode)
    .trim()
    .replace(/\n+/g, "\n");
}

describe("task markers in the markdown pipeline", () => {
  it.each([
    ["a paragraph", 'Do <t3-task id="a">this</t3-task> now', "Do {a:this} now"],
    ["a list item", '- <t3-task id="a">one</t3-task>\n- two', "{a:one}\ntwo"],
    ["a heading", '# <t3-task id="a">Title</t3-task>', "{a:Title}"],
    ["a table cell", '| h |\n| - |\n| <t3-task id="a">cell</t3-task> |', "h\n{a:cell}"],
    ["inline formatting", 'x <t3-task id="a">a **bold** b</t3-task>', "x {a:a bold b}"],
  ])("wraps a marker in %s", (_, markdown, expected) => {
    expect(rendered(markdown)).toBe(expected);
    expect(rendered(markdown, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)).toBe(expected);
  });

  it.each([
    ["open without close", 'a <t3-task id="a">text', "a text"],
    ["close without open", "a text</t3-task>", "a text"],
    ["invalid id", 'a <t3-task id="Bad Id">text</t3-task>', "a text"],
    ["missing id", "a <t3-task>text</t3-task>", "a text"],
    ["nested markers", 'a <t3-task id="a">x <t3-task id="b">y</t3-task> z</t3-task>', "a x y z"],
    ["an html block", '<t3-task id="a">\nblock text\n</t3-task>', "block text"],
    [
      "a partial open tag while streaming",
      'a <t3-task id="a">x</t3-task>\n\nb <t3-task id="',
      "a {a:x}\nb",
    ],
    ["a partial close tag while streaming", 'a <t3-task id="a">x</t3', "a x"],
  ])("hides tags and keeps text for %s", (_, markdown, expected) => {
    expect(rendered(markdown)).toBe(expected);
  });

  it("keeps markers in code literal", () => {
    const markdown = 'Use `<t3-task id="a">x</t3-task>`\n\n```\n<t3-task id="b">y</t3-task>\n```';
    expect(rendered(markdown)).toBe('Use <t3-task id="a">x</t3-task>\n<t3-task id="b">y</t3-task>');
    expect(collectT3TaskFragments(markdown).size).toBe(0);
    expect(stripT3TaskMarkers(markdown)).toBe(markdown);
  });
});

describe("task fragments", () => {
  it("groups fragments of one id in message order and keeps markdown source", () => {
    const markdown = [
      'First <t3-task id="a">step `one`</t3-task>.',
      "",
      "Unmarked paragraph.",
      "",
      '- <t3-task id="b">other</t3-task>',
      '- <t3-task id="a">step two</t3-task>',
    ].join("\n");
    expect([...collectT3TaskFragments(markdown)]).toEqual([
      ["a", ["step `one`", "step two"]],
      ["b", ["other"]],
    ]);
  });

  it("ignores invalid and unmatched markers", () => {
    expect(collectT3TaskFragments('<t3-task id="X">x</t3-task> <t3-task id="a">open').size).toBe(0);
  });
});

const BRIEFED = [
  'Do <t3-task id="a">the thing</t3-task> now.',
  "",
  '<t3-task-brief id="a">',
  "Goal: fix it.",
  "",
  "- file `x.ts`",
  "- keep **API**",
  "",
  "Done when tests pass.",
  "</t3-task-brief>",
  "",
  "Tail text",
].join("\n");

describe("task briefs", () => {
  it("collects a brief that spans blank lines and lists, first one per id", () => {
    const briefs = collectT3TaskBriefs(
      `${BRIEFED}\n\n<t3-task-brief id="a">\nsecond\n</t3-task-brief>`,
    );
    expect([...briefs.keys()]).toEqual(["a"]);
    expect(briefs.get("a")).toBe(
      "Goal: fix it.\n\n- file `x.ts`\n- keep **API**\n\nDone when tests pass.",
    );
  });

  it("never renders a brief, whatever nodes its body becomes", () => {
    expect(rendered(BRIEFED)).toBe("Do {a:the thing} now.\nTail text");
    expect(rendered(BRIEFED, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)).toBe(
      "Do {a:the thing} now.\nTail text",
    );
    expect(rendered('Text\n<t3-task-brief id="a">\ninline body\n</t3-task-brief>\nafter')).toBe(
      "Text\nafter",
    );
  });

  it("hides an unclosed brief to the end only while the message streams", () => {
    const streaming =
      'Do <t3-task id="a">x</t3-task>\n\n<t3-task-brief id="a">\nGoal: par\n\n- one';
    const streamingPlugins = withStreamingT3TaskMarkers(CHAT_MARKDOWN_REMARK_PLUGINS);
    expect(rendered(streaming, streamingPlugins)).toBe("Do {a:x}");
    expect(rendered('Do x\n\n<t3-task-brief id="a', streamingPlugins)).toBe("Do x");
    expect(collectT3TaskBriefs(streaming).size).toBe(0);

    const finished = 'Intro\n\n<t3-task-brief id="a">\nunclosed\n\nImportant';
    expect(rendered(finished)).toBe("Intro\nunclosed\nImportant");
    expect(stripT3TaskMarkers(finished)).toBe("Intro\n\nunclosed\n\nImportant");
  });

  it("launches with a brief only when it is hidden, and shows it when it is not HTML", () => {
    const notHtml = [
      'a \\* b <t3-task-brief id="a" data-x="1>SHOWN</t3-task-brief> tail',
      '\\<t3-task-brief id="a">SHOWN</t3-task-brief>',
    ];
    for (const markdown of notHtml) {
      expect(collectT3TaskBriefs(markdown).size).toBe(0);
      expect(rendered(markdown)).toContain("SHOWN");
    }
    const insideHtmlBlock = '- <div>\n  <t3-task-brief id="a">\n  SECRET\n  </t3-task-brief>';
    expect(collectT3TaskBriefs(insideHtmlBlock).get("a")).toBe("SECRET");
    expect(rendered(insideHtmlBlock)).not.toContain("SECRET");
  });

  it("keeps briefs in code literal", () => {
    const code =
      'Use `<t3-task-brief id="a">x</t3-task-brief>` or\n\n```\n<t3-task-brief id="a">\nx\n</t3-task-brief>\n```';
    expect(collectT3TaskBriefs(code).size).toBe(0);
    expect(stripT3TaskBriefs(code)).toBe(code);
    expect(rendered(code)).toContain('<t3-task-brief id="a">');
  });

  it("strips briefs and their tags from copied text", () => {
    expect(stripT3TaskMarkers(BRIEFED)).toBe("Do the thing now.\n\nTail text");
    expect(stripT3TaskBriefs(BRIEFED)).toBe(
      'Do <t3-task id="a">the thing</t3-task> now.\n\nTail text',
    );
  });
});

describe("stripT3TaskMarkers", () => {
  it("removes every tag outside code and keeps the text", () => {
    expect(
      stripT3TaskMarkers(
        'A <t3-task id="a">one</t3-task> B <t3-task id="x y">two</t3-task> C </t3-task>\n\n<t3-task id="c">\nblock\n</t3-task>',
      ),
    ).toBe("A one B two C \n\n\nblock\n");
  });
});

describe("buildT3TaskPrompt", () => {
  it("joins fragments, then extra instructions, then the stripped background", () => {
    expect(
      buildT3TaskPrompt({
        fragments: ["one", "two"],
        extraInstructions: "  be quick \n",
        backgroundReply: 'Reply <t3-task id="a">one</t3-task>',
      }),
    ).toBe(
      "one\n\ntwo\n\n## Extra instructions\n\nbe quick\n\n## Background (the reply this task came from)\n\nReply one",
    );
    expect(buildT3TaskPrompt({ fragments: ["one"], extraInstructions: "  " })).toBe("one");
  });

  it("uses the brief alone, then extra instructions and the source thread", () => {
    expect(
      buildT3TaskPrompt({
        fragments: ["one"],
        brief: "Goal: x",
        extraInstructions: "fast",
        backgroundReply: "Reply",
        sourceThreadId: "thread-1",
      }),
    ).toBe(
      "Goal: x\n\n## Extra instructions\n\nfast\n\nSource thread: thread-1 (read it with t3_thread_read if you need more context).",
    );
    expect(
      buildT3TaskPrompt({
        fragments: ["one"],
        worktreeBase: { branch: "main", uncommittedEditsLeftBehind: true },
      }),
    ).toBe(
      "one\n\nWorktree base: branch `main`. The source checkout had uncommitted edits that are not in this worktree.",
    );
    expect(
      buildT3TaskPrompt({
        fragments: ["one"],
        worktreeBase: { branch: "main", uncommittedEditsLeftBehind: false },
      }),
    ).toBe("one\n\nWorktree base: branch `main`.");
    expect(buildT3TaskPrompt({ fragments: ["one"], sourceThreadId: "thread-1" })).toBe(
      "one\n\nSource thread: thread-1 (read it with t3_thread_read if you need more context).",
    );
  });
});

describe("humanizeT3TaskId", () => {
  it("reads the id as a sentence-case title", () => {
    expect(humanizeT3TaskId("auth-tests")).toBe("Auth tests");
    expect(humanizeT3TaskId("a1")).toBe("A1");
  });
});
