import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";

const T3_TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const T3_TASK_HAST_PROPERTY = "dataT3Task";

export function isT3TaskId(id: string): boolean {
  return T3_TASK_ID_PATTERN.test(id);
}

const OPEN_TAG = /^<t3-task(\s[^>]*)?>$/i;
const CLOSE_TAG = /^<\/t3-task\s*>$/i;
const OPEN_ID_ATTRIBUTE = /^\s+id=(?:"([^"]*)"|'([^']*)')\s*$/;
const ANY_TAG = /<\/?t3-task(?:\s[^<>]*)?>/gi;
const BRIEF_OPEN_TAG = /<t3-task-brief(?:\s[^<>]*)?>/gi;
const BRIEF_CLOSE_TAG = /<\/t3-task-brief\s*>/gi;
const BRIEF_ID_ATTRIBUTE = /\sid=(?:"([^"]*)"|'([^']*)')/i;
// A tag the model is still typing: kept off the screen while the message streams.
const PARTIAL_TAIL = /<[^<>]*$/;
const PARTIAL_TAG_NAMES = ["<t3-task", "</t3-task>", "<t3-task-brief", "</t3-task-brief>"];
const MENTIONS_MARKER = /<\/?t3-task/i;
const MENTIONS_BRIEF = /<t3-task-brief/i;
const FLOW_PARENTS = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "footnoteDefinition",
]);

interface TaskNode {
  type?: string | undefined;
  value?: string | undefined;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
  data?:
    | {
        hName?: string | undefined;
        hProperties?: Record<string, unknown> | undefined;
        t3TaskText?: string | undefined;
      }
    | undefined;
  children?: TaskNode[] | undefined;
}

type MarkerFile = { readonly value: unknown };

function startOffset(node: TaskNode | undefined): number | undefined {
  return node?.position?.start.offset;
}
function endOffset(node: TaskNode | undefined): number | undefined {
  return node?.position?.end.offset;
}

function validId(match: RegExpExecArray | null): string | null {
  const id = match?.[1] ?? match?.[2];
  return id !== undefined && isT3TaskId(id) ? id : null;
}

function classify(node: TaskNode): { kind: "open"; id: string | null } | { kind: "close" } | null {
  if (node.type !== "html" || node.value === undefined) return null;
  if (CLOSE_TAG.test(node.value)) return { kind: "close" };
  const open = OPEN_TAG.exec(node.value);
  if (!open) return null;
  return { kind: "open", id: validId(OPEN_ID_ATTRIBUTE.exec(open[1] ?? "")) };
}

function rangeOf(node: TaskNode): [number, number] | null {
  const start = startOffset(node);
  const end = endOffset(node);
  return start === undefined || end === undefined ? null : [start, end];
}

function transformChildren(
  children: TaskNode[],
  source: string,
  ranges: Array<[number, number]>,
): TaskNode[] {
  if (!children.some((child) => classify(child) !== null)) return children;
  const output: TaskNode[] = [];
  let open: {
    id: string | null;
    node: TaskNode;
    outputIndex: number;
    depth: number;
    nested: boolean;
  } | null = null;

  const closeGroup = (closing: TaskNode | null) => {
    if (!open) return;
    const { id, node, outputIndex, nested } = open;
    open = null;
    const content = output.splice(outputIndex);
    const from = endOffset(node);
    const to = closing ? startOffset(closing) : undefined;
    if (closing && id !== null && !nested && from !== undefined && to !== undefined) {
      output.push({
        type: "t3Task",
        data: {
          hName: "span",
          hProperties: { [T3_TASK_HAST_PROPERTY]: id },
          t3TaskText: source.slice(from, to),
        },
        children: content,
      });
    } else {
      output.push(...content);
    }
  };

  for (const child of children) {
    const marker = classify(child);
    if (marker === null) {
      output.push(child);
      continue;
    }
    const range = rangeOf(child);
    if (range) ranges.push(range);
    if (marker.kind === "open") {
      if (open) {
        open.depth += 1;
        open.nested = true;
      } else {
        open = { id: marker.id, node: child, outputIndex: output.length, depth: 1, nested: false };
      }
    } else if (open) {
      open.depth -= 1;
      if (open.depth === 0) closeGroup(child);
    }
  }
  closeGroup(null);
  return output;
}

function hideTagsInFlowHtml(node: TaskNode, ranges: Array<[number, number]>) {
  const start = startOffset(node);
  if (start === undefined || node.value === undefined) return;
  for (const match of node.value.matchAll(ANY_TAG)) {
    ranges.push([start + match.index, start + match.index + match[0].length]);
  }
}

function stripPartialTail(tree: TaskNode) {
  let node = tree;
  for (let last = node.children?.at(-1); last; last = last.children?.at(-1)) node = last;
  if (node.type !== "text" || node.value === undefined) return;
  const tail = PARTIAL_TAIL.exec(node.value)?.[0].toLowerCase();
  if (
    tail !== undefined &&
    tail.length >= 3 &&
    (PARTIAL_TAG_NAMES.some((name) => name.startsWith(tail)) ||
      /^<t3-task(?:-brief)?\s[^>]*$/.test(tail))
  ) {
    node.value = node.value.slice(0, node.value.length - tail.length);
  }
}

function visit(node: TaskNode, source: string, ranges: Array<[number, number]>) {
  if (!node.children) return;
  if (FLOW_PARENTS.has(node.type ?? "")) {
    for (const child of node.children) {
      if (child.type === "html" && child.value && MENTIONS_MARKER.test(child.value)) {
        hideTagsInFlowHtml(child, ranges);
      }
    }
  } else {
    node.children = transformChildren(node.children, source, ranges);
  }
  for (const child of node.children) visit(child, source, ranges);
}

interface BriefRange {
  readonly id: string | null;
  /** To the end of the close tag; unclosed, to the end of the text while it streams, else of the open tag. */
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly closed: boolean;
}

function htmlRanges(tree: TaskNode): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  const walk = (node: TaskNode) => {
    if (node.type === "html") {
      const range = rangeOf(node);
      if (range) found.push(range);
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return found;
}

/**
 * Briefs found in the markdown source. A tag counts only where markdown parsed it as HTML, so an
 * escaped, malformed or code tag is shown as text and never launched.
 */
function findBriefRanges(tree: TaskNode, source: string, streaming: boolean): BriefRange[] {
  const html = htmlRanges(tree);
  const isHtml = (match: RegExpExecArray | RegExpMatchArray) =>
    html.some(([start, end]) => match.index! >= start && match.index! + match[0].length <= end);
  const closes = [...source.matchAll(BRIEF_CLOSE_TAG)].filter(isHtml);
  const briefs: BriefRange[] = [];
  let cursor = 0;
  for (const open of source.matchAll(BRIEF_OPEN_TAG)) {
    if (open.index < cursor || !isHtml(open)) continue;
    const bodyStart = open.index + open[0].length;
    const close = closes.find((match) => match.index >= bodyStart);
    // A finished message never completes an unclosed brief: hide the stray tag, keep the text.
    const end = close ? close.index + close[0].length : streaming ? source.length : bodyStart;
    cursor = end;
    briefs.push({
      id: validId(BRIEF_ID_ATTRIBUTE.exec(open[0])),
      start: open.index,
      end,
      bodyStart,
      bodyEnd: close ? close.index : end,
      closed: close !== undefined,
    });
  }
  return briefs;
}

/**
 * Drops everything the briefs cover. A brief opened by an HTML block spans several nodes (the
 * block ends at the first blank line), so this works on source offsets, at any depth.
 */
function pruneBriefs(node: TaskNode, source: string, briefs: readonly BriefRange[]) {
  if (!node.children) return;
  const kept: TaskNode[] = [];
  for (const child of node.children) {
    const range = rangeOf(child);
    const overlapping = range
      ? briefs.filter((brief) => range[0] < brief.end && range[1] > brief.start)
      : [];
    if (!range || overlapping.length === 0) {
      kept.push(child);
      continue;
    }
    if (overlapping.some((brief) => range[0] >= brief.start && range[1] <= brief.end)) continue;
    if (child.children) {
      pruneBriefs(child, source, briefs);
      if (child.children.length > 0) kept.push(child);
    } else if (child.value !== undefined && child.value === source.slice(range[0], range[1])) {
      let value = "";
      let from = range[0];
      for (const brief of [...overlapping].sort((a, b) => a.start - b.start)) {
        value += source.slice(from, Math.max(from, Math.min(brief.start, range[1])));
        from = Math.max(from, brief.end);
      }
      value += source.slice(Math.min(from, range[1]), range[1]);
      if (value.trim() !== "") kept.push({ ...child, value });
    }
    // A leaf whose value is not its source (indented or escaped) cannot be cut safely: drop it.
  }
  node.children = kept;
}

// What the plugin found in each parsed tree, for the helpers below that read the source back.
const parsedMarkers = new WeakMap<
  TaskNode,
  { readonly ranges: Array<[number, number]>; readonly briefs: BriefRange[] }
>();

/**
 * Pairs `<t3-task id>` html nodes within one phrasing parent into `span[data-t3-task]`; unpaired,
 * nested or invalid tags are dropped. Code is never an `html` node, so markers in code stay literal.
 */
export function remarkT3TaskMarkers(options?: { readonly streaming?: boolean }) {
  return (root: Root, file: MarkerFile) => {
    const tree: TaskNode = root;
    const source = String(file.value);
    const ranges: Array<[number, number]> = [];
    const briefs = MENTIONS_BRIEF.test(source)
      ? findBriefRanges(tree, source, options?.streaming === true)
      : [];
    pruneBriefs(tree, source, briefs);
    visit(tree, source, ranges);
    stripPartialTail(tree);
    parsedMarkers.set(tree, { ranges, briefs });
  };
}

const streamingPlugins = new WeakMap<PluggableList, PluggableList>();

/** The same plugin list for a message still streaming, where an unclosed brief is still being written. */
export function withStreamingT3TaskMarkers(plugins: PluggableList): PluggableList {
  let streaming = streamingPlugins.get(plugins);
  if (!streaming) {
    streaming = plugins.map((plugin) =>
      plugin === remarkT3TaskMarkers ? [remarkT3TaskMarkers, { streaming: true }] : plugin,
    );
    streamingPlugins.set(plugins, streaming);
  }
  return streaming;
}

const markerParser = unified().use(remarkParse).use(remarkGfm).use(remarkT3TaskMarkers).freeze();

function parseMarkers(markdown: string) {
  const tree: TaskNode = markerParser.runSync(markerParser.parse(markdown), markdown);
  return { tree, ...(parsedMarkers.get(tree) ?? { ranges: [], briefs: [] }) };
}

/** Fragments (markdown source between the tags) of every valid task, in message order. */
export function collectT3TaskFragments(markdown: string): ReadonlyMap<string, readonly string[]> {
  const tasks = new Map<string, string[]>();
  if (!MENTIONS_MARKER.test(markdown)) return tasks;
  const walk = (node: TaskNode) => {
    const id = node.data?.hProperties?.[T3_TASK_HAST_PROPERTY];
    if (node.type === "t3Task" && typeof id === "string") {
      const fragments = tasks.get(id) ?? [];
      fragments.push((node.data?.t3TaskText ?? "").trim());
      tasks.set(id, fragments);
    }
    node.children?.forEach(walk);
  };
  walk(parseMarkers(markdown).tree);
  return tasks;
}

/** Brief text of every task whose brief is complete, trimmed; the first brief of an id wins. */
export function collectT3TaskBriefs(markdown: string): ReadonlyMap<string, string> {
  const briefs = new Map<string, string>();
  if (!MENTIONS_BRIEF.test(markdown)) return briefs;
  for (const brief of parseMarkers(markdown).briefs) {
    if (brief.id === null || !brief.closed || briefs.has(brief.id)) continue;
    const text = markdown.slice(brief.bodyStart, brief.bodyEnd).trim();
    if (text) briefs.set(brief.id, text);
  }
  return briefs;
}

/** A removed brief takes the blank lines that followed it, so no gap is left behind. */
function briefRemoval(brief: BriefRange, markdown: string): readonly [number, number] {
  return [brief.start, brief.end + (/^[ \t]*\n*/.exec(markdown.slice(brief.end))?.[0].length ?? 0)];
}

function removeRanges(markdown: string, ranges: ReadonlyArray<readonly [number, number]>) {
  let result = markdown;
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** The message without brief blocks. Briefs in code are untouched. */
export function stripT3TaskBriefs(markdown: string): string {
  if (!MENTIONS_BRIEF.test(markdown)) return markdown;
  return removeRanges(
    markdown,
    parseMarkers(markdown).briefs.map((brief) => briefRemoval(brief, markdown)),
  ).trimEnd();
}

/** The message without marker tags and briefs; the text between the tags stays. Tags in code are untouched. */
export function stripT3TaskMarkers(markdown: string): string {
  if (!MENTIONS_MARKER.test(markdown)) return markdown;
  const { ranges, briefs } = parseMarkers(markdown);
  const stripped = removeRanges(markdown, [
    ...ranges,
    ...briefs.map((brief) => briefRemoval(brief, markdown)),
  ]);
  return briefs.length > 0 ? stripped.trimEnd() : stripped;
}

interface T3TaskPromptInput {
  readonly fragments: readonly string[];
  readonly extraInstructions?: string;
  /** The agent-written brief for this task; it replaces the fragments and the background reply. */
  readonly brief?: string;
  /** Full source reply, included as background for a task that starts a fresh thread. */
  readonly backgroundReply?: string;
  readonly sourceThreadId?: string;
  /** Set when the task runs in a new worktree, so the agent knows which code it starts from. */
  readonly worktreeBase?: { readonly branch: string; readonly uncommittedEditsLeftBehind: boolean };
}

export function buildT3TaskPrompt(input: T3TaskPromptInput): string {
  const brief = input.brief?.trim();
  const sections = [brief || input.fragments.join("\n\n")];
  const extra = input.extraInstructions?.trim();
  if (extra) sections.push(`## Extra instructions\n\n${extra}`);
  const background =
    brief || !input.backgroundReply ? "" : stripT3TaskMarkers(input.backgroundReply).trim();
  if (background) sections.push(`## Background (the reply this task came from)\n\n${background}`);
  if (input.worktreeBase) {
    sections.push(
      `Worktree base: branch \`${input.worktreeBase.branch}\`.${
        input.worktreeBase.uncommittedEditsLeftBehind
          ? " The source checkout had uncommitted edits that are not in this worktree."
          : ""
      }`,
    );
  }
  if (input.sourceThreadId) {
    sections.push(
      `Source thread: ${input.sourceThreadId} (read it with t3_thread_read if you need more context).`,
    );
  }
  return sections.join("\n\n");
}

/** "auth-tests" -> "Auth tests": the id read as a title. */
export function humanizeT3TaskId(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
