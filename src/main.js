'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// Both builds (the «Claude Sessions» app and `npm start`) keep their state in
// one folder; CSW_USER_DATA points a test run elsewhere.
app.setPath(
  'userData',
  process.env.CSW_USER_DATA || path.join(app.getPath('appData'), 'claude-sessions-widget')
);

// Where the Claude desktop app keeps one JSON file per Code-tab session:
// <root>/<workspace-id>/<folder-id>/local_<session-id>.json
// CSW_SESSIONS_ROOT and CSW_PROJECTS_ROOT point a test run at fixtures.
const SESSIONS_ROOT =
  process.env.CSW_SESSIONS_ROOT ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// Each session's transcript: <root>/<project slug>/<cliSessionId>.jsonl
const PROJECTS_ROOT = process.env.CSW_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');

// Both folders are watched; the poll only backs the watch up.
const POLL_MS = 15000;
const WATCH_THROTTLE_MS = 300;
// A transcript is read only while it changed recently; a turn whose transcript
// has been quiet this long is taken as dead (app quit, process killed).
const WORKING_STALE_MS = 10 * 60 * 1000;
// A question Claude asked stays "waiting" this long.
const WAITING_STALE_MS = 24 * 60 * 60 * 1000;
// A finished turn the person has not opened since counts this far back.
const UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_TOLERANCE_MS = 5000;
const TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_REINDEX_MS = 60 * 1000;
// Tools that stop a turn until the person answers.
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// After a usage limit resets, the stopped session waits for a «continue» this long.
const LIMIT_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;
// Opening this link switches the Claude app to the session; the middle segment
// is what the app itself puts in a session's link.
const DEFAULT_LINK_PREFIX = 'claude://claude.ai/epitaxy/';
const DEFAULT_HOTKEY = 'Control+Alt+S';
// More notifications than this from one scan are folded into one.
const MAX_NOTIFICATIONS = 3;

// The Swift helper reports the frontmost app and Claude's on-screen windows.
// Unpinned, the widget is shown only while Claude (or the widget) is frontmost
// with a window on screen; pinned, it stays. Notifications are skipped while
// Claude is frontmost.
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';
const FRONT_HELPER = path.join(__dirname, '..', 'build', 'front');
const FRONT_RESTART_MS = 3000;

const DEFAULT_SIZE = { width: 340, height: 640 };
const MIN_SIZE = { width: 260, height: 200 };

// Collapsing never resizes the window: the page clips itself to a square at the
// top-right corner (a CSS transition, smooth where a window resize is not),
// and the transparent rest of the window lets clicks through.
const DEFAULT_STATE = {
  hidden: [],
  // Pinned: stays on screen when Claude is minimized or another app is in front.
  pinned: false,
  notify: true,
  collapsed: false,
  bounds: null,
  linkPrefix: DEFAULT_LINK_PREFIX,
  hotkey: DEFAULT_HOTKEY,
};

let mainWindow = null;
let tray = null;
let isQuitting = false;
let state = { ...DEFAULT_STATE };
// Expanded by hovering the collapsed square; saved as collapsed.
let peeking = false;
let frontHelper = null;
let frontRestartTimer = null;
let front = { front: '', frontPid: -1, claudeWindows: 0 };
let followHidden = false;
let lastSnapshot = { sessions: [], hidden: [] };
let lastSnapshotJson = '';
let refreshing = null;
let pollTimer = null;
let watchTimer = null;
const watchers = [];
// id -> status from the previous scan; null until the first scan is in.
let previousStatus = null;
// Shown notifications, held so their click handlers outlive garbage collection.
const notifications = new Set();

// file -> { mtimeMs, session } so an unchanged session file is not re-read.
const sessionCache = new Map();
// transcript path -> { mtimeMs, size, kind }
const tailCache = new Map();
let transcriptIndex = new Map();
let transcriptIndexedAt = 0;

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    // Before the pin took over, `follow` was its own switch and `pinned` meant
    // always on top: the window stayed only with follow off.
    const migrated = 'follow' in parsed;
    if (migrated) {
      parsed.pinned = parsed.follow === false;
      delete parsed.follow;
    }
    state = { ...DEFAULT_STATE, ...parsed };
    if (migrated) saveState();
    if (!Array.isArray(state.hidden)) state.hidden = [];
    if (typeof state.linkPrefix !== 'string' || state.linkPrefix === '') {
      state.linkPrefix = DEFAULT_LINK_PREFIX;
    }
    if (typeof state.hotkey !== 'string') state.hotkey = DEFAULT_HOTKEY;
  } catch {
    state = { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    const saved = { ...state, collapsed: state.collapsed || peeking };
    fs.writeFileSync(statePath(), JSON.stringify(saved, null, 2));
  } catch (err) {
    console.error('state save failed', err);
  }
}

// A session in a git worktree belongs to the project the worktree was cut from.
function projectCwdOf(cwd) {
  return cwd.replace(/\/\.claude\/worktrees\/.*$/, '');
}

// The app's own one-line report on the last turn, when it is about that turn.
function summaryOf(s) {
  const raw = s.postTurnSummary;
  if (!raw || typeof raw !== 'object') return null;
  if (s.lastAssistantUuid && raw.summarizes_uuid && raw.summarizes_uuid !== s.lastAssistantUuid) {
    return null;
  }
  const needsAction = typeof raw.needs_action === 'string' ? raw.needs_action.trim() : '';
  const detail = typeof raw.status_detail === 'string' ? raw.status_detail.trim() : '';
  if (!needsAction && !detail) return null;
  return {
    category: typeof raw.status_category === 'string' ? raw.status_category : '',
    text: needsAction || detail,
    needsAction: needsAction !== '',
  };
}

function parseSession(raw) {
  const s = JSON.parse(raw);
  if (!s || typeof s.sessionId !== 'string') return null;
  const cwd = typeof s.cwd === 'string' ? s.cwd : '';
  const spawned = s.spawnedFrom && typeof s.spawnedFrom === 'object' ? s.spawnedFrom : null;
  return {
    id: s.sessionId,
    cliSessionId: typeof s.cliSessionId === 'string' ? s.cliSessionId : '',
    isArchived: s.isArchived === true,
    title: typeof s.title === 'string' && s.title.trim() !== '' ? s.title : '(без названия)',
    cwd,
    projectCwd: projectCwdOf(cwd),
    branch: typeof s.branch === 'string' ? s.branch : '',
    lastActivityAt: Number(s.lastActivityAt) || Number(s.createdAt) || 0,
    lastTurnEdgeAt: Number(s.lastTurnEdgeAt) || 0,
    lastFocusedAt: Number(s.lastFocusedAt) || 0,
    isStarred: s.isStarred === true,
    parentId: spawned && typeof spawned.sessionId === 'string' ? spawned.sessionId : null,
    summary: summaryOf(s),
  };
}

async function readSessionFile(file) {
  try {
    const { mtimeMs } = await fsp.stat(file);
    const cached = sessionCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.session;
    const session = parseSession(await fsp.readFile(file, 'utf8'));
    sessionCache.set(file, { mtimeMs, session });
    return session;
  } catch {
    sessionCache.delete(file);
    return null;
  }
}

async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function listSessionFiles() {
  const files = [];
  for (const workspace of await listDirs(SESSIONS_ROOT)) {
    for (const folder of await listDirs(workspace)) {
      let names = [];
      try {
        names = await fsp.readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('local_') && name.endsWith('.json')) files.push(path.join(folder, name));
      }
    }
  }
  return files;
}

async function reindexTranscripts() {
  const index = new Map();
  for (const dir of await listDirs(PROJECTS_ROOT)) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) index.set(name.slice(0, -'.jsonl'.length), path.join(dir, name));
    }
  }
  transcriptIndex = index;
  transcriptIndexedAt = Date.now();
}

async function readTail(file, size) {
  const handle = await fsp.open(file, 'r');
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Drop the first line when it was cut by the window.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

// A turn stopped by the API: the usage limit (with when it resets) or another
// error. Claude Code writes it as a synthetic assistant message.
function apiStop(entry, message) {
  if (!entry.isApiErrorMessage) return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join(' ')
    .trim();
  if (entry.apiError === 'usage_limit_reached') {
    const info = (entry.apiErrorParams && entry.apiErrorParams.rate_limit_info) || {};
    const resetsAt = Number(info.resetsAt) * 1000 || 0;
    return { kind: 'limited', resetsAt, text };
  }
  return { kind: 'error', text: text || String(entry.apiError || 'Ошибка API') };
}

// What the last conversation entry says about the turn: 'working' while Claude
// is mid-turn, 'waiting' on a question to the person, 'limited' or 'error'
// when the API stopped it, 'idle' once it ended.
function classifyTail(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== 'assistant' && entry.type !== 'user') || entry.isSidechain) continue;
    const message = entry.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (entry.type === 'assistant') {
      const stop = apiStop(entry, message);
      if (stop) return stop;
      const tools = content.filter((c) => c && c.type === 'tool_use').map((c) => c.name);
      if (tools.some((name) => WAITING_TOOLS.has(name))) return { kind: 'waiting' };
      if (tools.length > 0 || message.stop_reason === 'tool_use' || message.stop_reason == null) {
        return { kind: 'working' };
      }
      return { kind: 'idle' };
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : content
            .filter((c) => c && c.type === 'text')
            .map((c) => c.text)
            .join(' ');
    if (text.includes('[Request interrupted')) return { kind: 'idle' };
    return { kind: 'working' };
  }
  return { kind: 'idle' };
}

const IDLE = { kind: 'idle' };

// The turn's state from the transcript, aged: a quiet 'working' turn is dead,
// a question or an error is old news after a day. A usage limit holds until it
// resets, which can be days for the weekly one.
async function transcriptState(session, now) {
  if (!session.cliSessionId || now - session.lastActivityAt > UNREAD_WINDOW_MS) return IDLE;
  let file = transcriptIndex.get(session.cliSessionId);
  if (!file && now - transcriptIndexedAt > TRANSCRIPT_REINDEX_MS) {
    await reindexTranscripts();
    file = transcriptIndex.get(session.cliSessionId);
  }
  if (!file) return IDLE;
  try {
    const { mtimeMs, size } = await fsp.stat(file);
    const age = now - mtimeMs;
    const cached = tailCache.get(file);
    let tail;
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      tail = cached.tail;
    } else {
      tail = classifyTail(await readTail(file, size));
      tailCache.set(file, { mtimeMs, size, tail });
    }
    if (tail.kind === 'limited') {
      return tail.resetsAt === 0 || now - tail.resetsAt < LIMIT_RESET_WINDOW_MS ? tail : IDLE;
    }
    if (age > WAITING_STALE_MS) return IDLE;
    if (tail.kind === 'working' && age > WORKING_STALE_MS) return IDLE;
    return tail;
  } catch {
    transcriptIndex.delete(session.cliSessionId);
    return IDLE;
  }
}

function clock(ms, now) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString('ru-RU', { weekday: 'short' })} ${time}`;
}

// { status, notice? }. status: 'working' | 'waiting' (a question or a decision
// for the person, not yet opened, or a usage limit that has reset) | 'unread'
// (finished after the person last opened it) | 'limited' (stopped by the usage
// limit until it resets) | 'error' (stopped by another API error) | 'idle'.
// notice: a line that outranks the app's own report.
async function statusOf(session, now) {
  const tail = await transcriptState(session, now);
  if (tail.kind === 'limited') {
    if (tail.resetsAt && tail.resetsAt <= now) {
      return { status: 'waiting', notice: 'Лимит сброшен — можно продолжить' };
    }
    const until = tail.resetsAt ? `Лимит до ${clock(tail.resetsAt, now)}` : 'Лимит исчерпан';
    return { status: 'limited', notice: until, resetsAt: tail.resetsAt, limitText: tail.text };
  }
  if (tail.kind === 'error') return { status: 'error', notice: tail.text };
  if (tail.kind !== 'idle') return { status: tail.kind };
  const edge = Math.max(session.lastTurnEdgeAt, session.lastActivityAt);
  if (now - edge < UNREAD_WINDOW_MS && edge > session.lastFocusedAt + UNREAD_TOLERANCE_MS) {
    return { status: session.summary && session.summary.category === 'blocked' ? 'waiting' : 'unread' };
  }
  return { status: 'idle' };
}

async function scanSessions() {
  const files = await listSessionFiles();
  const live = new Set(files);
  for (const file of sessionCache.keys()) if (!live.has(file)) sessionCache.delete(file);
  const all = (await Promise.all(files.map(readSessionFile))).filter(Boolean);
  const now = Date.now();
  const rows = await Promise.all(
    all
      .filter((s) => !s.isArchived)
      .map(async (s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        projectCwd: s.projectCwd,
        branch: s.branch,
        lastActivityAt: s.lastActivityAt,
        isStarred: s.isStarred,
        parentId: s.parentId,
        summary: s.summary,
        ...(await statusOf(s, now)),
      }))
  );
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return rows;
}

// Detached ids of sessions that were archived or deleted are dropped.
function pruneHidden(sessions) {
  if (sessions.length === 0) return;
  const ids = new Set(sessions.map((s) => s.id));
  const kept = state.hidden.filter((id) => ids.has(id));
  if (kept.length !== state.hidden.length) {
    state.hidden = kept;
    saveState();
  }
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function sessionLink(id) {
  return `${state.linkPrefix}${id}`;
}

function projectName(s) {
  const cwd = s.projectCwd || '';
  if (!cwd || cwd.includes('/scratch-workspaces/')) return 'Без папки';
  return path.basename(cwd);
}

function isNeedsPerson(status) {
  return status === 'waiting' || status === 'unread' || status === 'error';
}

// A session that has just come to need the person (a question, a decision or a
// finished turn) gets a notification, unless Claude is frontmost already.
function notifyTransitions(sessions) {
  const current = new Map(sessions.map((s) => [s.id, s.status]));
  const before = previousStatus;
  previousStatus = current;
  if (!before || !state.notify || !Notification.isSupported()) return;
  if (front.front === CLAUDE_BUNDLE_ID) return;
  const hiddenSet = new Set(state.hidden);
  // One limit stops every working session at once: one notification for all.
  const limited = sessions.filter(
    (s) => !hiddenSet.has(s.id) && s.status === 'limited' && before.get(s.id) !== 'limited'
  );
  if (limited.length > 0) {
    showNotification({
      title: limited[0].notice,
      subtitle: limited[0].limitText || 'Лимит использования Claude',
      body: `Остановлены: ${limited.map((s) => s.title).join(', ')}`,
      onClick: () => void shell.openExternal(sessionLink(limited[0].id)),
    });
  }
  const fresh = sessions.filter(
    (s) => !hiddenSet.has(s.id) && isNeedsPerson(s.status) && !isNeedsPerson(before.get(s.id))
  );
  if (fresh.length === 0) return;
  if (fresh.length > MAX_NOTIFICATIONS) {
    showNotification({
      title: 'Сессии Claude',
      body: `Ждут тебя: ${fresh.length} — ${fresh
        .slice(0, 4)
        .map((s) => s.title)
        .join(', ')}`,
      onClick: showWindow,
    });
    return;
  }
  for (const s of fresh) {
    const fallback = s.status === 'unread' ? 'Claude закончил' : 'Claude ждёт ответа';
    showNotification({
      title: s.title,
      subtitle: projectName(s),
      body: s.notice || (s.summary ? s.summary.text : fallback),
      onClick: () => void shell.openExternal(sessionLink(s.id)),
    });
  }
}

function showNotification({ title, subtitle, body, onClick }) {
  const n = new Notification({ title, subtitle, body, silent: false });
  notifications.add(n);
  const drop = () => notifications.delete(n);
  n.on('click', () => {
    drop();
    onClick();
  });
  n.on('close', drop);
  n.show();
}

async function doRefresh(force) {
  const sessions = await scanSessions();
  pruneHidden(sessions);
  notifyTransitions(sessions);
  const snap = { sessions, hidden: state.hidden };
  const json = JSON.stringify(snap);
  lastSnapshot = snap;
  if (force || json !== lastSnapshotJson) {
    lastSnapshotJson = json;
    send('sessions:updated', snap);
    updateTray();
  }
  return snap;
}

// One scan at a time; a request during a scan reuses it.
function refresh(force = false) {
  if (!refreshing) {
    refreshing = doRefresh(force).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  return force ? refreshing.then(() => refresh(true)) : refreshing;
}

// Transcripts are written many times a second while Claude works: at most one
// scan per window, never postponed by further writes.
function scheduleWatchRefresh() {
  if (watchTimer) return;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    void refresh();
  }, WATCH_THROTTLE_MS);
}

function startWatching() {
  stopWatching();
  for (const root of [SESSIONS_ROOT, PROJECTS_ROOT]) {
    try {
      // macOS fs.watch supports recursive watching, which covers new folders too.
      watchers.push(fs.watch(root, { recursive: true }, scheduleWatchRefresh));
    } catch (err) {
      console.error('watch failed, polling only', root, err);
    }
  }
  pollTimer = setInterval(() => void refresh(), POLL_MS);
}

function stopWatching() {
  for (const w of watchers.splice(0)) w.close();
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(watchTimer);
  watchTimer = null;
}

function flags() {
  return {
    pinned: state.pinned,
    notify: state.notify,
    collapsed: state.collapsed,
    hotkey: state.hotkey,
  };
}

function sendFlags() {
  send('flags:updated', flags());
  updateTray();
}

// Always above other windows and on every desktop, Claude's full-screen one too.
function applyWindowLevel() {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function shouldShow() {
  if (state.pinned) return true;
  if (front.frontPid === process.pid) return true;
  return front.front === CLAUDE_BUNDLE_ID && front.claudeWindows > 0;
}

function applyFollow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const show = shouldShow();
  if (show && followHidden) {
    followHidden = false;
    mainWindow.showInactive();
  } else if (!show && !followHidden && mainWindow.isVisible()) {
    followHidden = true;
    mainWindow.hide();
  }
}

function onFrontLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed.front === 'string') {
      front = {
        front: parsed.front,
        frontPid: Number(parsed.frontPid) || -1,
        claudeWindows: Number(parsed.claudeWindows) || 0,
      };
      applyFollow();
    }
  } catch (err) {
    console.error('front helper line unreadable', line, err);
  }
}

function startFrontHelper() {
  if (frontHelper || !fs.existsSync(FRONT_HELPER)) return;
  const child = spawn(FRONT_HELPER, [], { stdio: ['ignore', 'pipe', 'ignore'] });
  frontHelper = child;
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      onFrontLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  child.on('exit', () => {
    if (frontHelper === child) frontHelper = null;
    if (!isQuitting) frontRestartTimer = setTimeout(startFrontHelper, FRONT_RESTART_MS);
  });
  child.on('error', (err) => console.error('front helper failed', err));
}

function stopFrontHelper() {
  clearTimeout(frontRestartTimer);
  if (frontHelper) {
    frontHelper.kill();
    frontHelper = null;
  }
}

function setPinned(pinned) {
  state.pinned = pinned === true;
  saveState();
  applyFollow();
  sendFlags();
}

function setNotify(notify) {
  state.notify = notify === true;
  saveState();
  sendFlags();
}

async function resetHidden() {
  state.hidden = [];
  saveState();
  await refresh(true);
}

function showWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  followHidden = false;
  mainWindow.show();
  // A menu bar app is not active by itself; take the keyboard for the search.
  app.focus({ steal: true });
  mainWindow.focus();
}

// Hidden by the person (hotkey, Esc): unpinned, it comes back with Claude.
function hideWindow() {
  if (!mainWindow) return;
  followHidden = !state.pinned;
  mainWindow.hide();
}

function onHotkey() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    hideWindow();
    return;
  }
  showWindow();
  send('ui:focus-search');
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    if (!globalShortcut.register(state.hotkey, onHotkey)) {
      console.error('hotkey taken by another app', state.hotkey);
    }
  } catch (err) {
    console.error('hotkey invalid', state.hotkey, err);
  }
}

// ⌃⌥S style label for an Electron accelerator.
function hotkeyLabel(accelerator) {
  const symbols = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘' };
  return accelerator
    .split('+')
    .map((part) => symbols[part] || part)
    .join('');
}

function trayImage() {
  // An SF Symbol first, then a system template image; empty falls back to a title.
  for (const name of ['rectangle.stack', 'NSListViewTemplate']) {
    try {
      const image = nativeImage.createFromNamedImage(name);
      if (!image.isEmpty()) {
        const sized = image.resize({ height: 16 });
        sized.setTemplateImage(true);
        return sized;
      }
    } catch {
      // try the next one
    }
  }
  return nativeImage.createEmpty();
}

function createTray() {
  const image = trayImage();
  tray = new Tray(image);
  if (image.isEmpty()) tray.setTitle('◧');
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const hiddenSet = new Set(lastSnapshot.hidden);
  const shown = lastSnapshot.sessions.filter((s) => !hiddenSet.has(s.id));
  const working = shown.filter((s) => s.status === 'working').length;
  const attention = shown.filter((s) => isNeedsPerson(s.status)).length;
  // The number next to the icon is what needs the person: answers or unread results.
  tray.setTitle(attention > 0 ? ` ${attention}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(`Сессии Claude — работают: ${working}, ждут тебя: ${attention}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать окно', accelerator: state.hotkey, click: onHotkey },
      { label: `Работают: ${working} · Ждут тебя: ${attention}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Закрепить — не прятать вместе с Claude',
        type: 'checkbox',
        checked: state.pinned,
        click: (item) => setPinned(item.checked),
      },
      {
        label: 'Уведомления',
        type: 'checkbox',
        checked: state.notify,
        click: (item) => setNotify(item.checked),
      },
      {
        label: `Вернуть открепленные (${state.hidden.length})`,
        enabled: state.hidden.length > 0,
        click: () => void resetHidden(),
      },
      { type: 'separator' },
      { label: 'Выход', role: 'quit' },
    ])
  );
}

function run(file, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

// github.com/<owner>/<repo> from the folder's origin remote, or ''.
async function githubRepoUrl(dir) {
  const remote = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], dir);
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}

// The branch's pull request when `gh` finds one, else the branch itself.
async function openOnGitHub(s) {
  const dir = fs.existsSync(s.cwd) ? s.cwd : s.projectCwd;
  const repo = await githubRepoUrl(dir);
  if (!repo) return;
  const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p));
  const pr = gh ? await run(gh, ['pr', 'view', s.branch, '--json', 'url', '-q', '.url'], dir) : '';
  void shell.openExternal(pr || `${repo}/tree/${encodeURIComponent(s.branch)}`);
}

async function hideSession(id) {
  if (typeof id !== 'string') return;
  if (!state.hidden.includes(id)) {
    state.hidden.push(id);
    saveState();
  }
  await refresh(true);
}

function showSessionMenu(id) {
  const s = lastSnapshot.sessions.find((x) => x.id === id);
  if (!s || !mainWindow) return;
  const dir = [s.cwd, s.projectCwd].find((d) => d && fs.existsSync(d)) || '';
  const items = [
    { label: 'Открыть в Claude', click: () => void shell.openExternal(sessionLink(s.id)) },
    { label: 'Скопировать ссылку', click: () => clipboard.writeText(sessionLink(s.id)) },
    { type: 'separator' },
    { label: 'Показать папку в Finder', enabled: dir !== '', click: () => void shell.openPath(dir) },
    {
      label: 'Открыть в Терминале',
      enabled: dir !== '',
      click: () => void run('open', ['-a', 'Terminal', dir], dir),
    },
  ];
  if (s.branch) {
    items.push({ label: `PR / ветка на GitHub (${s.branch})`, click: () => void openOnGitHub(s) });
  }
  items.push({ type: 'separator' }, { label: 'Открепить', click: () => void hideSession(s.id) });
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

function expandedBounds() {
  const b = state.bounds || {};
  return {
    x: b.x,
    y: b.y,
    width: b.width || DEFAULT_SIZE.width,
    height: b.height || DEFAULT_SIZE.height,
  };
}

function fitToDisplay(b) {
  if (b.x === undefined || b.y === undefined) return b;
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  return {
    x: Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height),
    width,
    height,
  };
}

// Settled collapsed: no traffic lights or resizing, clicks outside the square
// fall through (the page reports when the pointer is over the square), and the
// shadow redrawn around what is opaque.
function applyCollapsedChrome() {
  if (!mainWindow) return;
  const collapsed = state.collapsed;
  mainWindow.setWindowButtonVisibility(!collapsed);
  mainWindow.setResizable(!collapsed);
  mainWindow.setIgnoreMouseEvents(collapsed, { forward: true });
  mainWindow.setHasShadow(true);
  mainWindow.invalidateShadow();
}

// Starts a collapse or expand; the page runs the transition and then calls
// finishCollapse. The shadow is off meanwhile, as it would trail the old shape.
// A peek expands without being saved, so a restart comes back collapsed.
function setCollapsed(collapsed, options = {}) {
  const next = collapsed === true;
  if (!mainWindow) return;
  if (state.collapsed === next) {
    // Expanded by a peek and now kept open.
    if (!next && peeking && !options.peek) {
      peeking = false;
      saveState();
    }
    return;
  }
  state.collapsed = next;
  peeking = !next && options.peek === true;
  mainWindow.setHasShadow(false);
  if (next) {
    mainWindow.setWindowButtonVisibility(false);
    mainWindow.setResizable(false);
  } else {
    mainWindow.setIgnoreMouseEvents(false);
    // The square may have been dragged where the full window does not fit.
    const current = mainWindow.getBounds();
    const fitted = fitToDisplay(current);
    if (fitted.x !== current.x || fitted.y !== current.y) mainWindow.setBounds(fitted);
  }
  saveState();
  updateTray();
}

function finishCollapse() {
  applyCollapsedChrome();
}

function setMiniHover(over) {
  if (!mainWindow || !state.collapsed) return;
  mainWindow.setIgnoreMouseEvents(over !== true, { forward: true });
}

function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  state.bounds = mainWindow.getBounds();
  saveState();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    ...fitToDisplay(expandedBounds()),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Сессии Claude',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    // The page draws the rounded panel; the rest is see-through.
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowLevel();
  applyCollapsedChrome();
  mainWindow.on('moved', rememberBounds);
  mainWindow.on('resized', rememberBounds);
  // The close button hides the window; it comes back from the menu bar icon.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    followHidden = false;
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.showInactive();
    // The shadow follows the first painted shape only once it is on screen.
    setTimeout(() => mainWindow && mainWindow.invalidateShadow(), 300);
  });
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('sessions:get', () => refresh(true));

ipcMain.handle('sessions:open', (_e, id) => {
  if (typeof id !== 'string' || !/^local_[0-9a-f-]+$/i.test(id)) return false;
  void shell.openExternal(sessionLink(id));
  return true;
});

ipcMain.handle('sessions:hide', (_e, id) => hideSession(id));
ipcMain.handle('sessions:menu', (_e, id) => showSessionMenu(id));
ipcMain.handle('sessions:reset', () => resetHidden());

ipcMain.handle('flags:get', () => flags());
ipcMain.handle('window:set-pinned', (_e, pinned) => setPinned(pinned));
ipcMain.handle('window:set-collapsed', (_e, collapsed, options) => setCollapsed(collapsed, options));
ipcMain.handle('window:finish-collapse', () => finishCollapse());
ipcMain.handle('window:mini-hover', (_e, over) => setMiniHover(over));
ipcMain.handle('window:hide', () => hideWindow());

// One widget at a time: a second launch (npm start next to the app) shows the
// running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    // A menu bar utility: no Dock icon and no entry in ⌘Tab.
    if (app.dock) app.dock.hide();
    loadState();
    createTray();
    await createWindow();
    startWatching();
    startFrontHelper();
    registerHotkey();
    void refresh(true);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopWatching();
  stopFrontHelper();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  // Kept alive by the menu bar icon; quitting goes through its menu.
});
