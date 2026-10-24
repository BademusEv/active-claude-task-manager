# Claude Sessions (claude-sessions-widget)

A small always-on-top window that lists the Claude desktop app's Code-tab
sessions grouped by project folder, showing which ones Claude is working in and
which wait for you, with the app's own one-line report on each. Click a row to
switch the Claude app to that session. It lives in the menu bar: no Dock icon,
no ⌘Tab entry.

Only local sessions are shown: the app keeps cloud sessions on its server and
writes no list of them to disk.

## Install

```bash
npm install          # also compiles build/front (needs swiftc from Xcode)
npm run package      # builds ~/Applications/Claude Sessions.app (own name, icon, bundle id)
npm run autostart    # LaunchAgent: start at login, restart after a crash
```

`npm run autostart:remove` uninstalls the LaunchAgent. It starts the packaged
app when it is installed, else the development build; after `npm run package`
it is restarted on the new app by itself. Output goes to
`~/Library/Logs/claude-sessions-widget.log`, started afresh on every launch.
`npm start` runs the development build; a second copy only brings the running
one forward. Both keep their state in
`~/Library/Application Support/claude-sessions-widget/state.json`.

## What it shows

- Sessions come from the app's own store, one JSON file per session under
  `~/Library/Application Support/Claude/claude-code-sessions/`; archived ones
  are skipped. That folder and the transcripts under `~/.claude/projects` are
  watched, so a status change shows within a fraction of a second.
- Groups are project folders. A session in a git worktree
  (`<project>/.claude/worktrees/<name>`) goes under its project with a `⑂ branch`
  label; a session started from another one is indented under it.
- Status dot:
  - green, pulsing — Claude is mid-turn (the last conversation entry of the
    session's transcript; a turn quiet for 10 min counts as over).
  - blue, bold title — waits for you: a question (`AskUserQuestion`,
    `ExitPlanMode`), a decision the app's report marks as blocked, or a turn
    finished after you last opened the session (within 7 days).
  - yellow — stopped by the usage limit; the line under it says when it
    resets («Лимит до 15:20»). Once it has, the session turns blue with «Лимит
    сброшен — можно продолжить». Read from the synthetic message Claude Code
    writes (`apiError: usage_limit_reached`, `resetsAt`).
  - red — stopped by another API error, with its text.
  - grey — nothing new.
- Under a session that waits for you, the app's report on the last turn: what
  it needs from you, or what it did. An open question from the last week stays
  shown, muted, after you have read it.
- The title bar counters (blue: wait for you, green: working) filter the list
  by that status. The `7 д` toggle hides sessions idle for over a week; the
  search box matches title, project and branch. ⌥-click on a group header folds
  or unfolds every group.
- Right-click on a row: open it, copy its link, show its folder in Finder or a
  Terminal, open its branch's pull request on GitHub (or the branch, when `gh`
  finds no PR), detach it.

## Window, keyboard and notifications

- ⌃⌥S (anywhere) shows the panel with the cursor in the search; ↑/↓ pick a
  row, Enter opens it, Esc clears the search or hides the panel. The key is
  `hotkey` in `state.json`, as an Electron accelerator.
- A macOS notification comes when a session starts to wait for you or fails
  with an API error, unless Claude is the frontmost app; its click opens the
  session. More than three at once fold into one, and a usage limit that stops
  several sessions gives one notification naming them all. Switched off in the
  menu bar menu (Уведомления).
- The collapse button (top right) folds the panel into a small square at the
  same corner holding only the expand button and the number of sessions that
  wait for you (a green dot while Claude works). Resting the pointer on the
  square opens the panel until the pointer leaves; the expand button keeps it
  open. The square's edge drags it. The window never changes size for this: it
  is transparent, the page animates its own shape (`clip-path` and `opacity`),
  and while collapsed clicks outside the square go through to the windows below.
- The window is always above other windows, on every desktop. Unpinned (the
  default), it is shown only while the Claude app is frontmost with a window on
  screen, or the widget itself is; it hides when another app is activated or
  Claude is minimized. The pin (top right) keeps it on screen regardless.
  `build/front` (from `helper/front.swift`) reports the frontmost app every
  250 ms and exits with the widget; no Accessibility permission is needed.
- The menu bar icon shows how many sessions wait for you; its menu has
  Показать окно, the pin and notification switches, Вернуть открепленные and
  Выход. The close button only hides the window.
- A row opens `claude://claude.ai/epitaxy/<session id>`, the deep link the
  app gives for a session; `linkPrefix` in `state.json` changes it.
