/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

const TASK_MARKER_INSTRUCTIONS = `<task_markers>
When you propose follow-up work the user may want to run as its own thread, wrap each task in <t3-task id="ID">TEXT</t3-task> inside your reply. TEXT is a short, self-contained instruction. ID doubles as the task's title: 2-4 specific lowercase words joined by hyphens, such as "expired-token-tests", never generic like "task-1". Open and close tags stay in the same paragraph, list item, heading or table cell, on the same line as text. A task spread over several places reuses one ID. Never nest markers or put them in code. Mark only real proposals.
After your reply's markers, add one hidden block per task, with the tags on their own lines and never in code:
<t3-task-brief id="ID">
The message you would send an agent that has not seen this conversation: goal, relevant files, decisions and constraints so far, rejected approaches, and the done condition. Markdown, at most 150 words.
</t3-task-brief>
</task_markers>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** False omits the task marker instructions. */
  readonly taskMarkers?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>`;
  const sections = [runtimeInfo];
  if (runtime.taskMarkers !== false) sections.push(TASK_MARKER_INSTRUCTIONS);
  if (runtime.pullRequestLinking !== false) sections.push(PULL_REQUEST_LINKING_INSTRUCTIONS);
  return sections.join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
