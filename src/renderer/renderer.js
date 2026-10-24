'use strict';

const api = window.sessionsWidget;
const NO_FOLDER = 'Без папки';
const COLLAPSED_KEY = 'collapsedGroups';
const RECENT_KEY = 'recentOnly';
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEPTH = 4;
const COLLAPSE_TIMEOUT_MS = 600;
// Resting on the collapsed square this long opens the panel; leaving the
// panel this long folds it back.
const PEEK_OPEN_MS = 450;
const PEEK_CLOSE_MS = 350;

const STATUS_TITLES = {
  working: 'Claude работает',
  waiting: 'Claude ждёт тебя',
  unread: 'Claude закончил — ты ещё не смотрел',
  limited: 'Остановлено лимитом использования',
  error: 'Остановлено ошибкой API',
  idle: '',
};

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const chipAttentionEl = document.getElementById('chip-attention');
const chipWorkingEl = document.getElementById('chip-working');
const footerEl = document.getElementById('footer');
const resetEl = document.getElementById('reset');
const pinEl = document.getElementById('pin');
const searchEl = document.getElementById('search');
const recentEl = document.getElementById('recent');
const collapseEl = document.getElementById('collapse');
const expandEl = document.getElementById('expand');
const expandBadgeEl = document.getElementById('expand-badge');
const shellEl = document.getElementById('shell');
const miniEl = document.querySelector('.mini');

let snap = { sessions: [], hidden: [] };
let flags = { pinned: false, collapsed: false };
let collapsed = loadCollapsed();
let query = '';
let recentOnly = loadRecentOnly();
// null | 'attention' | 'working': the title bar counters filter by status.
let statusFilter = null;
// The row picked with the arrow keys, by session id.
let selectedId = null;
let animating = false;
let peeking = false;
let peekOpenTimer = null;
let peekCloseTimer = null;

function loadRecentOnly() {
  try {
    return localStorage.getItem(RECENT_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveRecentOnly() {
  try {
    localStorage.setItem(RECENT_KEY, String(recentOnly));
  } catch {
    // per-window convenience only
  }
}

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // per-window convenience only
  }
}

function projectOf(cwd) {
  if (!cwd || cwd.includes('/scratch-workspaces/')) return NO_FOLDER;
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || NO_FOLDER;
}

function isNeedsPerson(s) {
  return s.status === 'waiting' || s.status === 'unread' || s.status === 'error';
}

function matches(s, q) {
  if (!q) return true;
  return (
    s.title.toLowerCase().includes(q) ||
    projectOf(s.projectCwd).toLowerCase().includes(q) ||
    (s.branch && s.branch.toLowerCase().includes(q))
  );
}

function matchesStatus(s) {
  if (statusFilter === 'attention') return isNeedsPerson(s);
  if (statusFilter === 'working') return s.status === 'working';
  return true;
}

function ageOf(ms, nowMs) {
  const diff = nowMs - ms;
  if (!Number.isFinite(diff) || diff < 0) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'сейчас';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} д`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The summary line shows what needs the person, or what a finished turn did;
// on other rows only an open question from the last week.
function summaryLine(s, nowMs) {
  // A usage limit, its reset, or an API error says more than the last report.
  if (s.notice) return s.notice;
  if (!s.summary || s.status === 'working') return '';
  if (isNeedsPerson(s)) return s.summary.text;
  if (s.summary.needsAction && nowMs - s.lastActivityAt < RECENT_MS) return s.summary.text;
  return '';
}

// Rows in tree order: each session followed by the ones it started, a subtree
// ordered by its most recent activity. A child whose parent is not in the list
// stands on its own.
function treeOrder(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();
  const roots = [];
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && byId.has(r.parentId)) {
      if (!children.has(r.parentId)) children.set(r.parentId, []);
      children.get(r.parentId).push(r);
    } else {
      roots.push(r);
    }
  }
  const latestMemo = new Map();
  const latest = (r, seen = new Set()) => {
    if (latestMemo.has(r.id)) return latestMemo.get(r.id);
    seen.add(r.id);
    let max = r.lastActivityAt || 0;
    for (const c of children.get(r.id) || []) if (!seen.has(c.id)) max = Math.max(max, latest(c, seen));
    latestMemo.set(r.id, max);
    return max;
  };
  const byLatest = (a, b) => latest(b) - latest(a);
  const out = [];
  const visited = new Set();
  const walk = (r, depth) => {
    if (visited.has(r.id)) return;
    visited.add(r.id);
    out.push({ row: r, depth: Math.min(depth, MAX_DEPTH) });
    for (const c of (children.get(r.id) || []).slice().sort(byLatest)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byLatest)) walk(r, 0);
  // Rows caught in a parent cycle never hang off a root.
  for (const r of rows) walk(r, 0);
  return out;
}

function groupSessions(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const name = projectOf(s.projectCwd);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  }
  const latest = (rows) => Math.max(0, ...rows.map((r) => r.lastActivityAt || 0));
  return [...groups.entries()].sort(([a, ra], [b, rb]) => {
    if (a === NO_FOLDER) return 1;
    if (b === NO_FOLDER) return -1;
    return latest(rb) - latest(ra);
  });
}

function shortBranch(branch) {
  return branch.replace(/^claude\//, '');
}

function ageLabel(s, nowMs) {
  if (s.status === 'working') return 'работает';
  if (s.status === 'limited') return 'лимит';
  if (s.status === 'error') return 'ошибка';
  return ageOf(s.lastActivityAt, nowMs);
}

function renderRow(s, depth, nowMs) {
  const row = el('div', `row status-${s.status || 'idle'}`);
  row.dataset.id = s.id;
  if (s.isStarred) row.classList.add('starred');
  if (depth > 0) row.classList.add('child');
  if (s.id === selectedId) row.classList.add('selected');
  row.style.setProperty('--depth', String(depth));

  const main = el('button', 'row-main');
  main.type = 'button';
  const summary = summaryLine(s, nowMs);
  const status = STATUS_TITLES[s.status] || '';
  main.title = [s.title, status, summary, s.limitText, s.branch && `ветка ${s.branch}`, s.cwd]
    .filter(Boolean)
    .join('\n');

  const text = el('span', 'row-text');
  const titleLine = el('span', 'row-title-line');
  titleLine.append(el('span', 'row-title', s.title));
  if (s.branch) titleLine.append(el('span', 'row-branch', `⑂ ${shortBranch(s.branch)}`));
  text.append(titleLine);
  if (summary) text.append(el('span', 'row-summary', summary));

  main.append(
    el('span', 'dot'),
    text,
    el('span', 'row-age', ageLabel(s, nowMs))
  );
  main.addEventListener('click', () => {
    selectedId = s.id;
    void api.openSession(s.id);
  });

  const hide = el('button', 'row-hide', '✕');
  hide.type = 'button';
  hide.title = 'Открепить';
  hide.addEventListener('click', (e) => {
    e.stopPropagation();
    void api.hideSession(s.id);
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void api.showSessionMenu(s.id);
  });

  row.append(main, hide);
  return row;
}

function renderChip(chipEl, count, kind, label) {
  const active = statusFilter === kind;
  chipEl.hidden = count === 0 && !active;
  chipEl.classList.toggle('active', active);
  chipEl.querySelector('.chip-count').textContent = String(count);
  chipEl.title = active ? `${label} — показать все` : `${label} — показать только их`;
}

function render() {
  const nowMs = Date.now();
  const hiddenSet = new Set(snap.hidden);
  const q = query.trim().toLowerCase();
  const visible = snap.sessions.filter((s) => !hiddenSet.has(s.id));
  const working = visible.filter((s) => s.status === 'working').length;
  const attention = visible.filter(isNeedsPerson).length;
  // A session that needs the person stays in view whatever its age.
  const shown = visible.filter(
    (s) =>
      matches(s, q) &&
      matchesStatus(s) &&
      (statusFilter !== null || !recentOnly || s.status !== 'idle' || nowMs - s.lastActivityAt < RECENT_MS)
  );
  const groups = groupSessions(shown);

  const scrollTop = listEl.scrollTop;
  listEl.replaceChildren();
  countEl.textContent = String(shown.length);
  countEl.title =
    shown.length === visible.length ? `Сессий: ${visible.length}` : `Показано ${shown.length} из ${visible.length}`;
  renderChip(chipAttentionEl, attention, 'attention', 'Ждут тебя');
  renderChip(chipWorkingEl, working, 'working', 'Работают');
  recentEl.classList.toggle('active', recentOnly);

  if (groups.length === 0) {
    listEl.append(el('div', 'empty', visible.length === 0 ? 'Сессий пока нет.' : 'Ничего не найдено.'));
  }

  for (const [name, rows] of groups) {
    const group = el('section', 'group');
    // A search or a status filter opens every group so matches are not hidden.
    const isCollapsed = collapsed.has(name) && !q && statusFilter === null;
    if (isCollapsed) group.classList.add('collapsed');

    const groupWorking = rows.filter((r) => r.status === 'working').length;
    const header = el('button', 'group-header');
    header.type = 'button';
    header.title = '⌥-клик — свернуть или развернуть все группы';
    header.append(el('span', 'group-chevron', isCollapsed ? '▸' : '▾'), el('span', 'group-name', name));
    if (groupWorking > 0) header.append(el('span', 'group-working', `● ${groupWorking}`));
    header.append(el('span', 'group-count', String(rows.length)));
    header.addEventListener('click', (e) => {
      if (e.altKey) {
        const names = groups.map(([n]) => n);
        const anyOpen = names.some((n) => !collapsed.has(n));
        collapsed = anyOpen ? new Set(names) : new Set();
      } else if (collapsed.has(name)) {
        collapsed.delete(name);
      } else {
        collapsed.add(name);
      }
      saveCollapsed();
      render();
    });

    const rowsEl = el('div', 'rows');
    for (const { row, depth } of treeOrder(rows)) rowsEl.append(renderRow(row, depth, nowMs));

    group.append(header, rowsEl);
    listEl.append(group);
  }
  listEl.scrollTop = scrollTop;

  const hiddenCount = snap.hidden.length;
  footerEl.classList.toggle('hidden', hiddenCount === 0);
  resetEl.textContent = `Вернуть открепленные (${hiddenCount})`;

  // The collapsed square: the number of sessions waiting for the person, else a
  // green dot while Claude works somewhere, else a yellow one under a limit.
  const limited = visible.filter((s) => s.status === 'limited');
  expandBadgeEl.textContent = attention > 0 ? String(attention) : '';
  expandBadgeEl.classList.toggle('attention', attention > 0);
  expandBadgeEl.classList.toggle('working', attention === 0 && working > 0);
  expandBadgeEl.classList.toggle('limited', attention === 0 && working === 0 && limited.length > 0);
  expandEl.title = [
    `Развернуть — работают: ${working}, ждут тебя: ${attention}`,
    limited.length > 0 ? `${limited[0].notice}: ${limited.length}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Rows the arrow keys walk: the ones on screen, in order.
function visibleRows() {
  return [...listEl.querySelectorAll('.group:not(.collapsed) .row')];
}

function select(id) {
  selectedId = id;
  for (const row of listEl.querySelectorAll('.row.selected')) row.classList.remove('selected');
  const row = id && listEl.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
  }
}

function moveSelection(step) {
  const rows = visibleRows();
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.dataset.id === selectedId);
  const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
  select(rows[next].dataset.id);
}

function clipTransitionDone() {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      shellEl.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (e) => {
      if (e.target === shellEl && e.propertyName === 'clip-path') done();
    };
    const timer = setTimeout(done, COLLAPSE_TIMEOUT_MS);
    shellEl.addEventListener('transitionend', onEnd);
  });
}

// The window keeps its size; the page animates its own shape, and the main
// process switches the window's chrome before and after. `peek` opens the panel
// for as long as the pointer stays on it.
async function setCollapsed(next, { peek = false } = {}) {
  if (animating) return;
  const isCollapsed = document.body.classList.contains('collapsed');
  if (isCollapsed === next) {
    // An open peek kept for good.
    if (!next && peeking && !peek) {
      peeking = false;
      await api.setCollapsed(false, { peek: false });
    }
    return;
  }
  animating = true;
  try {
    peeking = !next && peek;
    await api.setCollapsed(next, { peek: peeking });
    document.body.classList.toggle('collapsed', next);
    await clipTransitionDone();
    await api.finishCollapse();
    // The pointer may already rest on the square, with no move to report it.
    if (next && miniEl.matches(':hover')) await api.setMiniHover(true);
  } finally {
    animating = false;
  }
}

function cancelPeekTimers() {
  clearTimeout(peekOpenTimer);
  clearTimeout(peekCloseTimer);
  peekOpenTimer = null;
  peekCloseTimer = null;
}

function renderFlags() {
  pinEl.classList.toggle('active', flags.pinned);
  pinEl.title = flags.pinned
    ? 'Закреплено: виджет остаётся на экране, даже когда Claude свёрнут или не активен'
    : 'Не закреплено: виджет прячется вместе с Claude';
  if (flags.hotkey) searchEl.placeholder = `Поиск  ${hotkeyLabel(flags.hotkey)}`;
}

function hotkeyLabel(accelerator) {
  const symbols = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘' };
  return accelerator
    .split('+')
    .map((part) => symbols[part] || part)
    .join('');
}

function toggleStatusFilter(kind) {
  statusFilter = statusFilter === kind ? null : kind;
  render();
}

pinEl.addEventListener('click', () => void api.setPinned(!flags.pinned));
chipAttentionEl.addEventListener('click', () => toggleStatusFilter('attention'));
chipWorkingEl.addEventListener('click', () => toggleStatusFilter('working'));
collapseEl.addEventListener('click', () => {
  cancelPeekTimers();
  void setCollapsed(true);
});
expandEl.addEventListener('click', () => {
  cancelPeekTimers();
  void setCollapsed(false);
});

// Collapsed, the window lets clicks through except over the square; resting
// on the square peeks into the panel.
miniEl.addEventListener('mouseenter', () => {
  void api.setMiniHover(true);
  if (!document.body.classList.contains('collapsed')) return;
  clearTimeout(peekOpenTimer);
  peekOpenTimer = setTimeout(() => void setCollapsed(false, { peek: true }), PEEK_OPEN_MS);
});
miniEl.addEventListener('mouseleave', () => {
  clearTimeout(peekOpenTimer);
  void api.setMiniHover(false);
});
shellEl.addEventListener('mouseenter', () => clearTimeout(peekCloseTimer));
shellEl.addEventListener('mouseleave', () => {
  if (!peeking) return;
  clearTimeout(peekCloseTimer);
  peekCloseTimer = setTimeout(() => {
    // Typing in the search keeps the panel open.
    if (peeking && document.activeElement !== searchEl) void setCollapsed(true);
  }, PEEK_CLOSE_MS);
});

resetEl.addEventListener('click', () => void api.resetHidden());
searchEl.addEventListener('input', () => {
  query = searchEl.value;
  selectedId = null;
  render();
});
recentEl.addEventListener('click', () => {
  recentOnly = !recentOnly;
  saveRecentOnly();
  render();
});

document.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('collapsed')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    const rows = visibleRows();
    const id = selectedId && rows.some((r) => r.dataset.id === selectedId) ? selectedId : rows[0]?.dataset.id;
    if (id) {
      e.preventDefault();
      select(id);
      void api.openSession(id);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (searchEl.value || statusFilter) {
      searchEl.value = '';
      query = '';
      statusFilter = null;
      render();
    } else {
      void api.hideWindow();
    }
  }
});

api.onSessionsUpdated((next) => {
  snap = next;
  render();
});

api.onFlagsUpdated((next) => {
  flags = next;
  renderFlags();
});

// The global hotkey: open the panel for good and type straight into the search.
api.onFocusSearch(async () => {
  cancelPeekTimers();
  await setCollapsed(false);
  searchEl.focus();
  searchEl.select();
});

async function boot() {
  flags = await api.getFlags();
  if (flags.collapsed) {
    document.body.classList.add('no-anim', 'collapsed');
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-anim')));
  }
  renderFlags();
  snap = await api.getSessions();
  render();
  // Ages tick without a new snapshot.
  setInterval(render, 30000);
}

void boot();
