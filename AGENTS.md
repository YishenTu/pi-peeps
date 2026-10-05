# Peeps coding-agent guidance

Human usage, support, and contributor documentation belongs in `README.md`. Keep durable coding-agent constraints here, not in a parallel implementation guide. Code, types, and tests are the reference for module layouts, schemas, and ordinary implementation details.

## Product and compatibility constraints

- This is extension-only. Use public Pi APIs; do not patch Pi core, access private runtime fields, monkey-patch the host, or require proposed host APIs.
- A child is a general-purpose, fresh-context Pi session. The parent talks to it only with ordinary messages. Its process lives at most as long as its parent runtime; under a saved parent its session persists, so a later message resumes it. Do not inject the parent's transcript, restart or resume children without a parent message, add a task protocol or persistent teammate identities, or introduce a daemon.
- The human viewer is read-only and stays inside the parent's TUI. Do not switch the main session or replace its editor to inspect a child.
- Pi packages and TypeBox are host-provided peer dependencies. Keep development copies in devDependencies, not bundled/runtime dependencies that can duplicate host classes or registries.

## Lifetime and messaging

- The run manager owns child lifetime, independently of tool calls and views. Viewer close releases only presentation/read leases. Runtime replacement must synchronously fence old-owner sends before awaiting teardown.
- Mandatory child shutdown must run and be awaited even if optional host UI teardown throws. Keep this guarantee in the shared lifecycle cleanup path, not duplicated across event handlers.
- Normal parent Stop leaves children working and holds later outcomes until an ordinary interactive prompt reaches `before_agent_start`. Input alone, viewer interaction, or another extension's turn is not authorization to release the hold.
- Parent shutdown, reload, session replacement, and tree navigation close old-owner children, aborting any work. Cancellation of the navigation does not resurrect them; only a later message does.
- Every parent message is RPC `prompt` with `streamingBehavior: "steer"`: Pi starts a run when the child is idle and steers when it is working. Do not check child state first and choose (that races), and do not use raw `steer`, which can strand input if the child becomes idle before admission. Messages sent during startup queue behind the task.
- `handled` is a native admission disposition: a child command/input extension consumed the message. Return it rather than treating it as a failure; no run starts and nothing is reported. A consumed task is different: the parent is waiting, so report that there is no answer.
- Interrupt is `clear_queue` then `abort` on a working child only (aborting before Pi starts the run can strand it). It keeps the child and returns the discarded messages.
- Resume reopens the child's recorded session id in its own run directory, and only after the old process has exited, so one session file never has two writers. Pi silently creates a new session when the id is missing, so verify `get_state` reports the recorded session file and id, and fail otherwise. Only the owning parent session may resume (a forked parent must not share the file); ephemeral parents cannot. Concurrent messages share one resume, and the task is never re-sent.
- Idle auto-close applies only to resumable children; closing an ephemeral child would lose its context. A working child never idles out.
- Report when the child goes quiet: after `agent_settled`, with no prompt awaiting admission, not streaming or compacting. `agent_end` is not quiet because retries and admitted messages can continue the work. Several messages may feed one report, and a report must never reuse an earlier report's answer.

## Results and native delivery

- Final assistant text is exact: concatenate text blocks without trimming, inserting separators, summarizing, or truncating. Only a normal `stop` with nonempty text is an answer; otherwise report `no-answer` with the reason, and `failed` only when the child itself ends. Label partial inspection output honestly.
- Automatic completion uses a custom notice with `deliverAs: "steer", triggerTurn: true`, including when the parent is idle. Do not substitute a fake human prompt or silently defer normally idle results.
- These notices are custom messages in Pi but user-role content to providers, not system-role instructions. Known upstream wake/queue/startup limitations are compatibility caveats, not authorization to change core; user-facing details are in the README.
- Each report is a snapshot, deduplicated by run and report sequence, which continues across resumes. Closing, idle auto-close, and interrupt are the parent's own requests and report nothing, except that an interrupted run which already produced an answer still reports it. Validate owner epoch/spawn-anchor ancestry before sending. The host's void `sendMessage` is not an acknowledgement; a persisted branch entry proves append, not model consumption.
- Do not blindly resend unconfirmed notices: native queue clearing can lose them, while raw abort can retain them. Historical metadata must not replay outcomes or restart work.
- Display collapse, bounded inspection, and archive-size limits must not alter the automatic final answer.

## Launch, storage, and inspection

- Launch the matching installed Pi RPC entry with the current Node executable, not a guessed `pi` from PATH. Preserve same-cwd trust and reproducible resource/tool restrictions; reject unsupported profiles instead of silently broadening permissions or changing models.
- Do not put tasks, parent transcripts, or API-key values in launch argv. Clear stale parent session metadata from child environments.
- Keep the child recursion guard before registration, including tools reachable through codemode. Cancel blocking child dialogs; never auto-approve them.
- Persistent parents use isolated native child archives outside the normal session picker; ephemeral parents get no durable child archive. Parent metadata stores references, not duplicate transcripts.
- Archive inspection is read-only: validate path containment and bound reads before parsing. Do not use `SessionManager.open`, which may migrate/repair files, and never resume a child to recover missing history; only a parent message resumes. Preserve pre-compaction history when reconstructing the archived branch.
- Read leases pin projected history, not processes. Release terminal persistent projections when unpinned; do not discard ephemeral history on the assumption that an archive exists.
- RPC assistant updates are delta-only; finalized messages are authoritative. Child tool renderers cannot cross RPC, so use native fallback rendering.
- Pi overlay compositing does not lay out a ScrollView, and its overlay-options callback is resolved only on open. Keep the viewer's scrolling/window dimensions consistent with the compositor under resize.

## Verification

Use the development commands in the README. Lifecycle/delivery changes need the isolated integration tests; UI or wiring changes also need the PTY smoke.

- Tests must use temporary agent directories and scripted providers, never personal config, real credentials, or paid model calls.
- Do not install Peeps into the user's Pi configuration as part of testing.
- Exercise UI-teardown failures through the extension lifecycle surface, retaining coverage of mandatory child cleanup and the no-late-wake fence.
