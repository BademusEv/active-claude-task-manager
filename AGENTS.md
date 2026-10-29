# AGENTS.md

Instructions for any AI coding agent (Codex CLI reads this file natively; Claude Code reads
it through the `@AGENTS.md` import in `CLAUDE.md`). This is the source of truth for agent
behaviour: edit here, let the other files link in. What the widget is, how to install it and
what it shows are in [README.md](README.md); do not duplicate them here.

## Start here (in order)

1. [README.md](README.md) — what the widget does and how it is installed.
2. This file, in full.
3. The source file that owns the area (map below).

## Code map

| Area | File |
|---|---|
| Main process: session scan, statuses, notifications, tray, window, hotkey, IPC | `src/main.js` |
| Bridge between page and main process (`window.sessionsWidget`) | `src/preload.js` |
| Page: list, groups, tree, filters, keyboard, collapse/peek animation | `src/renderer/renderer.js` |
| Page markup and styles | `src/renderer/index.html`, `src/renderer/styles.css` |
| Every user-facing string, English and Russian | `src/i18n.js` |
| Frontmost-app helper (Swift, built to `build/front`) | `helper/front.swift` |
| App icon, drawn at build time | `scripts/make-icon.swift` |
| Build `Claude Sessions.app` and install it | `scripts/package.sh` |
| LaunchAgent install/remove | `scripts/install-launch-agent.sh` |

## Stack

- Electron 32, plain CommonJS JavaScript, no bundler, no framework; the page is vanilla DOM.
- A Swift command-line helper (`build/front`) for the frontmost app and Claude's windows.
- Packaged with `@electron/packager`; started at login by a per-user LaunchAgent.
- macOS only, Apple silicon and Intel. Node 22.12+ (`@electron/packager` requires it;
  `scripts/package.sh` checks it, the CPU and `swift` before building).

## Commands

```sh
npm install                # also compiles build/front (postinstall; only a warning without swiftc)
npm start                  # development build; a second copy only focuses the running one
npm run build:helper       # recompile build/front after editing helper/front.swift
npm run package            # build, ad-hoc sign, install ~/Applications/Claude Sessions.app, restart the LaunchAgent
npm run autostart          # install the LaunchAgent and start the widget now
npm run autostart:remove   # uninstall the LaunchAgent
```

After a change, rebuild with `npm run package` so the running app picks it up; `npm start`
alone does not replace it.

## Checks

No test suite. Before declaring a change done:

1. `node --check` on every changed `.js` file.
2. Run the change in a probe: a throwaway Electron script, kept outside the repo, that
   `require`s `src/main.js` and inspects the page with `webContents.executeJavaScript` and
   `webContents.capturePage`. Run it with
   `./node_modules/.bin/electron <probe.js>` and these variables:

   | Variable | Points the run at |
   |---|---|
   | `CSW_USER_DATA` | a scratch state folder (always set it: the real one belongs to the running app, and the single-instance lock would quit the probe) |
   | `CSW_SESSIONS_ROOT` | fixture session JSON files instead of the Claude app's store |
   | `CSW_PROJECTS_ROOT` | fixture transcripts instead of `~/.claude/projects` |

   Stub `shell.openExternal` in the probe to check links without opening them.
3. For animation smoothness, record `requestAnimationFrame` timestamps in the page; do not
   poll `CGWindowListCopyWindowInfo` in a tight loop (it stalls WindowServer and fakes
   100-200 ms gaps).

## Data sources (read-only)

| What | Where | Used for |
|---|---|---|
| One JSON file per Code-tab session | `~/Library/Application Support/Claude/claude-code-sessions/<ws>/<folder>/local_<id>.json` | title, cwd, branch, timestamps, parent (`spawnedFrom.sessionId`), archived, starred, the app's last-turn report |
| Session transcript | `~/.claude/projects/<slug>/<cliSessionId>.jsonl` | whether a turn is running, waiting on a question, or stopped by the API |
| Widget state | `~/Library/Application Support/claude-sessions-widget/state.json` | language, detached ids, pin, notifications, collapsed, bounds, `linkPrefix`, `hotkey` |

- Find a transcript by `cliSessionId` across all project folders: the slug changes when a
  session moves folders.
- Cloud sessions are not on disk and not in the app's session list; do not try to fetch them
  (it would need the person's claude.ai credentials).

## Status rules

Owned by `statusOf` and `classifyTail` in `src/main.js`. Read the transcript tail
(last 256 KB), skip every entry that is not `assistant`/`user` or is `isSidechain`:

| Status | Condition |
|---|---|
| `working` | last entry is a `tool_use`/`tool_result`/prompt, or an assistant entry with no `stop_reason`; dropped after 10 min of silence |
| `waiting` | a pending `AskUserQuestion`/`ExitPlanMode`; or a finished turn not opened since whose `postTurnSummary.status_category` is `blocked`; or a usage limit that has reset (24 h) |
| `limited` | a synthetic assistant message with `isApiErrorMessage` and `apiError: "usage_limit_reached"`, until `apiErrorParams.rate_limit_info.resetsAt` |
| `error` | any other `isApiErrorMessage` (24 h) |
| `unread` | the turn ended (`lastTurnEdgeAt`/`lastActivityAt`) more than 5 s after `lastFocusedAt`, within 7 days |
| `idle` | everything else |

`postTurnSummary` is current only when its `summarizes_uuid` equals the session's
`lastAssistantUuid`. `waiting`, `unread` and `error` count as "needs the person" (badge,
tray number, notifications); `limited` does not.

## Constraints

- Never write to the Claude app's folders or `~/.claude`; the widget only reads them.
- No network requests from the widget. It only opens `claude://` session links and GitHub
  pages on the person's click.
- Put text into the page with `textContent`, never `innerHTML`; keep the CSP in
  `index.html` and `contextIsolation`/`sandbox` on.
- Run external programs with `execFile` and argument arrays, never through a shell: branch
  names and paths come from session files.
- Collapse and expand must not resize the window (see Gotchas); keep them to `clip-path`
  and `opacity` on `.shell`.
- A new field in `state.json` gets a default in `DEFAULT_STATE`; a renamed or removed one
  gets a migration in `loadState` (see `follow` → `pinned`, and `language`, which is `ru`
  for settings saved before it existed).
- Every user-facing string lives in `src/i18n.js`, in both `en` (the default) and `ru`,
  with the same keys; the main process `require`s it and the page loads it as a script
  (`window.I18N`). No literal UI text in `main.js`, `renderer.js` or `index.html` beyond
  the English placeholders the page overwrites. Text cached with a file (titles, API error
  text) is translated when the row is built, not when the file is read, so a language
  switch applies at once.
- A new action that changes what the person set (the list, a switch, the language) pushes
  an entry on `undoStack` in `src/main.js` with a label and the code that puts the old
  value back; the undo path calls the setter with `{ record: false }` so undoing is not
  itself recorded. Rescans and sessions the Claude app adds never go on the stack.
- Smallest correct diff. Do not commit unless the person asks.

## Gotchas

- Animating the window size (`setBounds(..., true)`) judders: Chromium re-lays out every
  frame. Hence the transparent window, the CSS-clipped `.shell`, and
  `setIgnoreMouseEvents(true, { forward: true })` outside the collapsed square, switched off
  while the pointer is on it.
- With asar the helper cannot be spawned: `scripts/package.sh` packages with `--no-asar`
  and leaves `node_modules` out (the widget has no runtime dependencies).
- `NSWorkspace.frontmostApplication` only updates while a run loop spins; the helper polls
  from a `Timer` on the main run loop, not a sleep loop. It exits when its parent dies.
- `nativeImage.createFromNamedImage` does not resolve SF Symbols in Electron 32; the tray
  uses `NSListViewTemplate`.
- `launchctl bootstrap` right after `bootout` fails with error 5 until the old job is gone;
  the install script waits for it.
- `userData` is set explicitly in `src/main.js` so the packaged app («Claude Sessions») and
  `npm start` share one state folder.
- Computer-use tools cannot target the app (it is in `~/Applications` and not indexed);
  check the window through probes instead.
