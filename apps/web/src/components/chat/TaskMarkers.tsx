import {
  buildT3TaskPrompt,
  collectT3TaskBriefs,
  collectT3TaskFragments,
  humanizeT3TaskId,
} from "@t3tools/shared/taskMarkers";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { createContext, use, useState, type ReactNode } from "react";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProject, useThreadShell } from "../../state/entities";
import { useManagedPolicy } from "../../state/managedPolicy";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button, InlineButton } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { resolveCompatibleRuntimeMode, resolveRuntimeModeOptions } from "./runtimeModeConfig";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type TimelineRow, TimelineRowCtx } from "./timelineRowContext";

type ProjectedItem = NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;

interface TaskMarkerMessage {
  readonly text: string;
  readonly streaming: boolean;
  readonly projectedItem: ProjectedItem;
}

const TaskMarkerMessageContext = createContext<TaskMarkerMessage | null>(null);

export function TaskMarkerMessageProvider({
  value,
  children,
}: {
  value: TaskMarkerMessage | null;
  children: ReactNode;
}) {
  return <TaskMarkerMessageContext value={value}>{children}</TaskMarkerMessageContext>;
}

/** A fragment that is all of its block's text lights the block, so a paragraph reads as one task. */
function wholeBlockOf(fragment: HTMLElement): HTMLElement | null {
  const block = fragment.parentElement;
  return block !== null && block.textContent?.trim() === fragment.textContent?.trim()
    ? block
    : null;
}

/** Marks every fragment of the task inside the message root through the DOM, so hovering does not re-render the message. */
function highlightTask(element: HTMLElement, id: string, on: boolean) {
  const root = element.closest("[data-t3-task-root]");
  for (const fragment of root?.querySelectorAll<HTMLElement>(`[data-t3-task="${id}"]`) ?? []) {
    (wholeBlockOf(fragment) ?? fragment).toggleAttribute(
      wholeBlockOf(fragment) ? "data-task-block-active" : "data-task-active",
      on,
    );
  }
}

/** Moving between lines or fragments of the same task never ends its highlight. */
function staysInTask(element: HTMLElement, id: string, next: EventTarget | null) {
  if (!(next instanceof Element)) return false;
  if (next.closest(`[data-t3-task="${id}"]`)) return true;
  const block = wholeBlockOf(element);
  return block !== null && block.contains(next);
}

// The vertical padding closes the gap between wrapped lines, so the pointer never leaves the task there.
const FRAGMENT_CLASS_NAME =
  "box-decoration-clone rounded-sm py-1 underline decoration-primary/40 decoration-dotted underline-offset-4 transition-colors duration-150 data-task-active:bg-primary/12 data-task-active:decoration-primary/70";
const FRAGMENT_ACTIVE_CLASS_NAME = `${FRAGMENT_CLASS_NAME} cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`;

export function TaskMarkerFragment({ id, children }: { id: string; children: ReactNode }) {
  const message = use(TaskMarkerMessageContext);
  const ctx = use(TimelineRowCtx);
  const [open, setOpen] = useState(false);
  const enabled = useEnvironmentSettings(
    ctx.activeThreadEnvironmentId,
    (settings) => settings.taskMarkersEnabled,
  );
  const highlight = {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) =>
      highlightTask(event.currentTarget, id, true),
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      if (!staysInTask(event.currentTarget, id, event.relatedTarget))
        highlightTask(event.currentTarget, id, false);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => highlightTask(event.currentTarget, id, true),
    onBlur: (event: React.FocusEvent<HTMLElement>) => highlightTask(event.currentTarget, id, false),
  };
  if (!enabled) return children;
  // Without a fork handler (guest view, side chat) nothing can be launched from the message.
  if (message === null || message.streaming || ctx.onRunTaskInFork === undefined) {
    return (
      <span data-t3-task={id} className={FRAGMENT_CLASS_NAME} {...highlight}>
        {children}
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton={false}
        render={<span data-t3-task={id} className={FRAGMENT_ACTIVE_CLASS_NAME} {...highlight} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup width="md">
        <TaskLaunchForm id={id} message={message} onStart={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

function useStartThreadTurn() {
  return useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
}

const TASK_MODES = [
  { value: "worktree", label: "New thread · worktree" },
  { value: "new-thread", label: "New thread · this checkout" },
  { value: "sub-thread", label: "Sub-thread · this checkout" },
] as const;

type TaskMode = (typeof TASK_MODES)[number]["value"];

const isTaskMode = (value: unknown): value is TaskMode =>
  TASK_MODES.some((option) => option.value === value);

/**
 * Launches a top-level thread in the source thread's project: in its checkout, or in a new
 * worktree cut from the source thread's branch (the composer's "New worktree" convention).
 */
async function startNewThread(input: {
  readonly startTurn: ReturnType<typeof useStartThreadTurn>;
  readonly environmentId: EnvironmentId;
  readonly sourceThread: EnvironmentThreadShell;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  /** Present for a new worktree: the checkout's current ref is the base when the thread has none. */
  readonly worktree: { readonly projectCwd: string; readonly baseBranch: string | null } | null;
  readonly title: string;
  readonly text: string;
}): Promise<ThreadId> {
  const { sourceThread, modelSelection } = input;
  const baseBranch = input.worktree?.baseBranch ?? null;
  if (input.worktree !== null && baseBranch === null) {
    throw new Error("Could not find a branch to start a worktree from.");
  }
  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  const result = await input.startTurn({
    environmentId: input.environmentId,
    input: {
      threadId,
      message: { messageId: newMessageId(), role: "user", text: input.text, attachments: [] },
      modelSelection,
      titleSeed: input.title,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: sourceThread.projectId,
          title: input.title,
          modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: sourceThread.branch,
          worktreePath: input.worktree === null ? sourceThread.worktreePath : null,
          createdAt,
        },
        ...(input.worktree === null || baseBranch === null
          ? {}
          : {
              prepareWorktree: {
                projectCwd: input.worktree.projectCwd,
                baseBranch,
              },
              runSetupScript: true,
            }),
      },
      createdAt,
    },
  });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) throw new Error("The launch was interrupted.");
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error("Could not start the new thread.");
  }
  return threadId;
}

function TaskLaunchForm({
  id,
  message,
  onStart,
}: {
  id: string;
  message: TaskMarkerMessage;
  onStart: () => void;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const sourceThread = useThreadShell(ctx.threadRef);
  const project = useProject(
    ctx.threadRef && sourceThread
      ? scopeProjectRef(ctx.threadRef.environmentId, sourceThread.projectId)
      : null,
  );
  const startThreadTurn = useStartThreadTurn();
  const checkoutCwd = sourceThread?.worktreePath ?? project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    checkoutCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: ctx.activeThreadEnvironmentId,
          input: { cwd: checkoutCwd },
        }),
  );
  const [extraInstructions, setExtraInstructions] = useState("");
  const [mode, setMode] = useState<TaskMode>("worktree");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode | undefined>(
    sourceThread?.runtimeMode,
  );
  const runId = message.projectedItem.item.runId;
  // The model of the run that wrote the reply; the thread's current one only when that run is gone.
  const sourceModel =
    ctx.runs.find((run) => run.id === runId)?.modelSelection ?? sourceThread?.modelSelection;
  const [modelSelection, setModelSelection] = useState<ModelSelection | undefined>(sourceModel);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: message.projectedItem.sourceThreadId,
    sourceItemId: message.projectedItem.sourceItemId,
  });
  const fragments = collectT3TaskFragments(message.text).get(id) ?? [];
  const brief = collectT3TaskBriefs(message.text).get(id);
  const worktreeBaseBranch = sourceThread?.branch ?? gitStatus.data?.refName ?? null;
  const uncommittedEditsLeftBehind =
    mode === "worktree" && gitStatus.data?.hasWorkingTreeChanges === true;
  // The agent's brief carries the context; without one the fragments and the reply stand in.
  const promptFor = (backgroundReply?: string) =>
    buildT3TaskPrompt({
      fragments,
      extraInstructions,
      sourceThreadId: message.projectedItem.sourceThreadId,
      ...(brief === undefined ? {} : { brief }),
      ...(backgroundReply === undefined ? {} : { backgroundReply }),
      ...(mode === "worktree" && worktreeBaseBranch !== null
        ? { worktreeBase: { branch: worktreeBaseBranch, uncommittedEditsLeftBehind } }
        : {}),
    });
  const canSubThread =
    runId !== null &&
    canForkProjectedAssistantItem({
      projectedItem: message.projectedItem,
      capabilities: support.providerSession?.capabilities,
    });
  const canNewThread = sourceThread !== null && ctx.threadRef !== null && project !== null;
  const canRun =
    modelSelection !== undefined &&
    runtimeMode !== undefined &&
    (mode === "sub-thread"
      ? canSubThread
      : // A worktree needs the checkout's state: its base ref and whether edits stay behind.
        canNewThread && (mode !== "worktree" || gitStatus.data !== undefined));

  const launch = async (
    selection: ModelSelection,
    runtime: RuntimeMode,
  ): Promise<ThreadId | null> => {
    if (mode === "sub-thread") {
      if (runId === null) return null;
      return (
        (await ctx.onRunTaskInFork?.({
          sourceThreadId: message.projectedItem.sourceThreadId,
          runId,
          prompt: promptFor(),
          modelSelection: selection,
          runtimeMode: runtime,
        })) ?? null
      );
    }
    if (sourceThread === null || ctx.threadRef === null || project === null) return null;
    return startNewThread({
      startTurn: startThreadTurn,
      environmentId: ctx.threadRef.environmentId,
      sourceThread,
      modelSelection: selection,
      runtimeMode: runtime,
      worktree:
        mode === "worktree"
          ? {
              projectCwd: project.workspaceRoot,
              baseBranch: worktreeBaseBranch,
            }
          : null,
      title: deriveThreadTitleSeed({ text: fragments.join(" "), attachments: [] }),
      text: promptFor(message.text),
    });
  };
  // Runs after the popover closed, so the source thread stays usable and in view.
  const run = () => {
    if (modelSelection === undefined || runtimeMode === undefined || ctx.threadRef === null) return;
    const { environmentId } = ctx.threadRef;
    onStart();
    launch(modelSelection, runtimeMode).then(
      (threadId) => {
        if (threadId === null) return;
        const toastId = toastManager.add({
          type: "success",
          title: "Task started",
          actionProps: {
            children: "Open",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
              });
            },
          },
        });
      },
      (failure: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not start the task",
          description: failure instanceof Error ? failure.message : "Could not run this task.",
        }),
    );
  };

  if (fragments.length === 0) {
    return <p className="text-muted-foreground text-sm">This task is no longer available.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate font-medium text-sm">{humanizeT3TaskId(id)}</p>
        <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-xs">
          <span className="min-w-0 flex-1 truncate">{fragments[0]}</span>
          {fragments.length > 1 ? <span className="shrink-0">{fragments.length} parts</span> : null}
        </div>
      </div>
      <textarea
        aria-label="Extra instructions"
        placeholder="Extra instructions (optional)"
        value={extraInstructions}
        onChange={(event) => setExtraInstructions(event.target.value)}
        className="field-sizing-content block max-h-32 min-h-9 w-full resize-none rounded-md bg-muted/50 px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground focus-visible:bg-muted/80 sm:text-sm"
      />
      {uncommittedEditsLeftBehind ? (
        <p className="text-muted-foreground text-xs">
          Uncommitted changes in this checkout won't be in the worktree. Commit them first, or{" "}
          <InlineButton onClick={() => setMode("new-thread")}>use this checkout</InlineButton>.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {modelSelection && runtimeMode ? (
            <TaskModelPicker
              environmentId={ctx.activeThreadEnvironmentId}
              projectId={sourceThread?.projectId ?? null}
              selection={modelSelection}
              onChange={setModelSelection}
              runtimeMode={runtimeMode}
              onRuntimeModeChange={setRuntimeMode}
            />
          ) : null}
        </div>
        <Group aria-label="Run task" className="shrink-0">
          <Button size="sm" disabled={!canRun} onClick={run}>
            Run task
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  aria-label={`Run mode: ${TASK_MODES.find((option) => option.value === mode)?.label}`}
                />
              }
            >
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuRadioGroup
                value={mode}
                onValueChange={(value) => {
                  if (isTaskMode(value)) setMode(value);
                }}
              >
                {TASK_MODES.map((option) => (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    closeOnClick
                    disabled={option.value === "sub-thread" && !canSubThread}
                  >
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </Group>
      </div>
    </div>
  );
}

/** The composer's model picker (provider, model and effort), holding its choice locally. */
function TaskModelPicker(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const { selection } = props;
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, props.projectId);
  const activeEntry = entries.find((entry) => entry.instanceId === selection.instanceId);
  const traits = activeEntry
    ? {
        provider: activeEntry.driverKind,
        instanceId: selection.instanceId,
        models: activeEntry.models,
        model: selection.model,
        modelOptions: selection.options ?? [],
        allowPromptInjectedEffort: false,
        planModeEnabled: false,
        onModelOptionsChange: (options: ModelSelection["options"]) =>
          props.onChange(createModelSelection(selection.instanceId, selection.model, options)),
      }
    : null;
  const managedPolicy = useManagedPolicy(props.environmentId);
  const runtimeModeOptions = resolveRuntimeModeOptions(
    resolveCompatibleRuntimeMode(props.runtimeMode, activeEntry?.snapshot.supportedRuntimeModes)
      .modes,
    managedPolicy,
  );
  const effort = describeComposerEffort(traits, settings.effortDisplay, "sm");
  return (
    <ProviderModelPicker
      environmentId={props.environmentId}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        selection.instanceId,
        selection.model,
      )}
      triggerClassName="min-w-0"
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      effortColumn={<ComposerEffortColumn traits={traits} />}
      footer={
        <ComposerPickerFooter
          traits={traits}
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={runtimeModeOptions}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      }
      onInstanceModelChange={(instanceId, model) =>
        props.onChange(createModelSelection(instanceId, model))
      }
    />
  );
}
