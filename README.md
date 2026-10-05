# Peeps

Subagents for [Pi](https://github.com/earendil-works/pi).

Your main agent hands tasks to background agents and keeps working. Each answer comes back automatically, and you can watch any subagent's thread live without leaving your session.

- **Delegate in plain language.** Ask the main agent to split up work; it starts subagents as needed.
- **No polling.** Each answer reaches the main agent as soon as it's ready.
- **Just talk to them.** The main agent messages a subagent the way you'd type into Pi: a working subagent takes it as steering, an idle one picks up where it left off, and a closed one wakes up with its conversation intact.
- **Watch live.** Open any subagent's thread in a read-only viewer inside Pi.

## Install

```sh
pi install git:github.com/YishenTu/pi-peeps
```

Or try it for one session without installing:

```sh
pi -e git:github.com/YishenTu/pi-peeps
```

Works in Pi's terminal UI on macOS and Linux (Linux not yet tested). Windows and compiled Pi binaries aren't supported.

## Usage

Just ask, for example:

> Use subagents to review the auth module and the billing module in parallel.

Each subagent is a Pi session of its own: it starts with a fresh conversation in the same directory and uses the main agent's model unless told otherwise. Whenever it finishes working, its answer comes back. The main agent can also interrupt a subagent's current work without losing it.

Subagents don't hold on to resources: one that sits idle for 10 minutes closes, and all of them close when your session ends. Messaging a closed subagent resumes it where it left off, even after you reload or restart Pi.

### Watching subagents

| Key | Action |
| --- | --- |
| `/peeps` or **Ctrl+Shift+A** | Open the subagent list |
| **Enter** | Open a subagent's live thread |
| **↑/↓, PgUp/PgDn, Home/End** | Scroll (End follows live output) |
| **h** | Hide or show finished subagents |
| **Escape** | Back / close |
| `/peeps interrupt <id>` | Stop a subagent's current work |
| `/peeps close <id\|all>` | Close a subagent |

## Good to know

- **Shared files.** Subagents work in your directory and can edit the same files as the main agent. They aren't sandboxed, and closing one doesn't undo its edits.
- **Stop.** Pressing Stop on the main agent doesn't stop subagents. Their answers wait until you send your next message.
- **No approvals.** If a subagent asks for confirmation, the request is declined and that subagent stops.
- **History.** For saved sessions, subagent sessions are kept in a folder beside the main session file, named after it (`<session>.jsonl` → `<session>/`). They don't appear in Pi's session picker and are not deleted automatically, even if you delete the main session. Only the session that started a subagent can resume it.
- **Ephemeral sessions** (`--no-session`) keep no subagent history, so their subagents can't resume and never close for idleness.

Some delivery edge cases come from Pi itself: [#5581](https://github.com/earendil-works/pi/issues/5581), [#9886](https://github.com/earendil-works/pi/issues/9886), [#10267](https://github.com/earendil-works/pi/issues/10267), [#6744](https://github.com/earendil-works/pi/issues/6744), [#9632](https://github.com/earendil-works/pi/issues/9632).

## Development

Run `npm run pi` in a checkout or worktree to make your Pi load Peeps from it (the last one run wins), then `/reload`. Pi loads it in place, so `/reload` also picks up later code changes.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:tui # optional terminal smoke test; requires Python 3
```

## License

[MIT](LICENSE)
