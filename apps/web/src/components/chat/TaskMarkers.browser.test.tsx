import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  startTurn: vi.fn(),
  shell: null as unknown,
  refName: null as string | null,
  dirty: false,
  enabled: true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => state.shell) as never,
  useProject: (() => ({ workspaceRoot: "/repo" })) as never,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.startTurn,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { refName: state.refName, hasWorkingTreeChanges: state.dirty },
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  const useEnvironmentSettings: typeof actual.useEnvironmentSettings = (environmentId, select) => {
    const settings = {
      ...actual.useEnvironmentSettings(environmentId),
      taskMarkersEnabled: state.enabled,
    };
    return select ? select(settings) : (settings as never);
  };
  return { ...actual, useEnvironmentSettings };
});
vi.mock("../../state/v2ItemSupport", () => ({
  useV2ItemSupport: () => ({ providerSession: undefined }),
}));

import ChatMarkdown from "../ChatMarkdown";
import { toastManager } from "../ui/toast";
import { TaskMarkerMessageProvider } from "./TaskMarkers";
import { TimelineRowCtx } from "./timelineRowContext";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const RUN_MODEL = { instanceId: "claude", model: "opus" };
const TEXT = [
  'Do <t3-task id="a">first part</t3-task> and <t3-task id="b">other task</t3-task>.',
  "",
  'Later <t3-task id="a">second part</t3-task>',
].join("\n");

function setup(streaming = false, threadBranch: string | null = "main", text = TEXT) {
  state.refName = null;
  state.dirty = false;
  state.enabled = true;
  state.startTurn.mockReset();
  state.startTurn.mockResolvedValue(AsyncResult.success(undefined));
  state.shell = {
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: "codex", model: "gpt" },
    runtimeMode: "full-access",
    branch: threadBranch,
    worktreePath: null,
  };
  const onRunTaskInFork = vi.fn(async () => ThreadId.make("fork-1"));
  const ctx = {
    onRunTaskInFork,
    runs: [{ id: RunId.make("run-1"), modelSelection: RUN_MODEL }],
    threadRef: { environmentId, threadId },
    activeThreadEnvironmentId: environmentId,
  } as unknown as ComponentProps<typeof TimelineRowCtx>["value"];
  const projectedItem = {
    sourceThreadId: threadId,
    sourceItemId: "item-1",
    item: { type: "assistant_message", runId: RunId.make("run-1"), status: "completed" },
  } as never;
  const ui = (
    <TimelineRowCtx value={ctx}>
      <div data-t3-task-root="true">
        <TaskMarkerMessageProvider value={{ text, streaming, projectedItem }}>
          <ChatMarkdown text={text} cwd={undefined} isStreaming={streaming} />
        </TaskMarkerMessageProvider>
      </div>
    </TimelineRowCtx>
  );
  return { ui, onRunTaskInFork };
}

it("highlights every fragment of the hovered task", async () => {
  const { ui } = setup();
  await using screen = await render(ui, { router: "/" });
  const fragments = (id: string) =>
    [...screen.container.querySelectorAll(`[data-t3-task="${id}"]`)] as HTMLElement[];
  expect(fragments("a")).toHaveLength(2);

  await screen.getByText("first part").hover();
  expect(fragments("a").map((fragment) => fragment.hasAttribute("data-task-active"))).toEqual([
    true,
    true,
  ]);
  expect(fragments("b")[0]!.hasAttribute("data-task-active")).toBe(false);
});

it("keeps the highlight while the pointer moves between fragments of the same task", async () => {
  const { ui } = setup();
  await using screen = await render(ui, { router: "/" });
  const [first, second] = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-t3-task="a"]'),
  ] as [HTMLElement, HTMLElement];
  await screen.getByText("first part").hover();
  first.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: second }));
  expect([first, second].map((fragment) => fragment.hasAttribute("data-task-active"))).toEqual([
    true,
    true,
  ]);
  first.dispatchEvent(
    new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  expect(first.hasAttribute("data-task-active")).toBe(false);
});

it("runs the task in a new worktree with the source run's model, in the background", async () => {
  const { ui } = setup();
  const toast = vi.spyOn(toastManager, "add");
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("textbox", { name: "Extra instructions" }).fill("go fast");
  await page.getByRole("button", { name: "Run task", exact: true }).click();

  const [{ input }] = state.startTurn.mock.calls[0]!;
  expect(input.modelSelection).toEqual(RUN_MODEL);
  expect(input.runtimeMode).toBe("full-access");
  expect(input.bootstrap.createThread).toMatchObject({
    projectId: "project-1",
    worktreePath: null,
  });
  expect(input.bootstrap.prepareWorktree).toEqual({ projectCwd: "/repo", baseBranch: "main" });
  expect(input.message.text).toContain("first part\n\nsecond part\n\n## Extra instructions");
  expect(input.message.text).toContain("## Background");
  expect(input.message.text).not.toContain("<t3-task");
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Task started" })),
  );
  await vi.waitFor(() =>
    expect(page.getByRole("textbox", { name: "Extra instructions" }).elements()).toHaveLength(0),
  );
});

it("starts the worktree from the checkout's current ref when the thread has no branch", async () => {
  const { ui } = setup(false, null);
  state.refName = "feat/current";
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  const [{ input }] = state.startTurn.mock.calls[0]!;
  expect(input.bootstrap.prepareWorktree).toEqual({
    projectCwd: "/repo",
    baseBranch: "feat/current",
  });
});

it("launches from the agent's brief when the reply has one", async () => {
  const { ui } = setup(
    false,
    "main",
    `${TEXT}\n\n<t3-task-brief id="a">\nGoal: x.\n\n- y\n</t3-task-brief>`,
  );
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  const [{ input }] = state.startTurn.mock.calls[0]!;
  expect(input.message.text).toBe(
    "Goal: x.\n\n- y\n\nWorktree base: branch `main`.\n\nSource thread: thread-1 (read it with t3_thread_read if you need more context).",
  );
});

it("warns that uncommitted edits stay behind, and offers this checkout instead", async () => {
  const { ui } = setup();
  state.dirty = true;
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  expect(state.startTurn.mock.calls[0]![0].input.message.text).toContain(
    "The source checkout had uncommitted edits that are not in this worktree.",
  );

  await screen.getByText("first part").click();
  await page.getByRole("button", { name: "use this checkout" }).click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  const { input } = state.startTurn.mock.calls[1]![0];
  expect(input.bootstrap.prepareWorktree).toBeUndefined();
  expect(input.message.text).not.toContain("Worktree base");
});

it("keeps a span forged with raw HTML as plain text", async () => {
  const { ui } = setup(false, "main", `<span data-t3-task='a"]b'>forged</span> text`);
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("forged text").hover();
  expect(screen.container.querySelector("[data-t3-task]")).toBeNull();
});

it("renders tasks as plain text when task markers are turned off", async () => {
  const { ui } = setup();
  state.enabled = false;
  await using screen = await render(ui, { router: "/" });
  await expect.element(screen.getByText("Do first part and other task.")).toBeVisible();
  expect(screen.container.querySelector("[data-t3-task]")).toBeNull();
});

it("runs in this checkout, or forks, when that mode is picked", async () => {
  const { ui, onRunTaskInFork } = setup();
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("button", { name: /Run mode/ }).click();
  await page.getByRole("menuitemradio", { name: "New thread · this checkout" }).click();
  await vi.waitFor(() => expect(page.getByRole("menuitemradio").elements()).toHaveLength(0));
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  const [{ input }] = state.startTurn.mock.calls[0]!;
  expect(input.bootstrap.prepareWorktree).toBeUndefined();
  expect(input.bootstrap.createThread).toMatchObject({ branch: "main", worktreePath: null });

  await screen.getByText("first part").click();
  await page.getByRole("button", { name: /Run mode/ }).click();
  await page.getByRole("menuitemradio", { name: "Sub-thread · this checkout" }).click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  expect(onRunTaskInFork).toHaveBeenCalledWith({
    sourceThreadId: threadId,
    runId: RunId.make("run-1"),
    prompt: expect.stringMatching(/^first part\n\nsecond part\n\nSource thread: thread-1 /),
    modelSelection: RUN_MODEL,
    runtimeMode: "full-access",
  });
});

it("reports a failed launch in a toast", async () => {
  const { ui, onRunTaskInFork } = setup();
  onRunTaskInFork.mockRejectedValue(new Error("fork broke"));
  const toast = vi.spyOn(toastManager, "add");
  await using screen = await render(ui, { router: "/" });
  await screen.getByText("first part").click();
  await page.getByRole("button", { name: /Run mode/ }).click();
  await page.getByRole("menuitemradio", { name: "Sub-thread · this checkout" }).click();
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "fork broke" }),
    ),
  );
});

it("does not open a popover for fragments of a streaming message", async () => {
  const { ui } = setup(true);
  await using screen = await render(ui, { router: "/" });
  const fragment = screen.container.querySelector('[data-t3-task="a"]') as HTMLElement;
  expect(fragment.getAttribute("role")).toBeNull();
  await screen.getByText("first part").click();
  expect(page.getByRole("button", { name: "Run task", exact: true }).elements()).toHaveLength(0);
});
