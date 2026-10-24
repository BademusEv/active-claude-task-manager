'use strict';

// Every user-facing string, in English (the default) and Russian. The main
// process requires this file; the page loads it as a script and reads
// window.I18N. A new string goes into both languages.
(function (root) {
  const en = {
    locale: 'en-US',
    appName: 'Claude Sessions',
    sessions: 'Sessions',
    untitled: '(untitled)',
    noFolder: 'No folder',

    // statuses
    statusWorking: 'Claude is working',
    statusWaiting: 'Claude is waiting for you',
    statusUnread: 'Claude finished; you have not looked yet',
    statusLimited: 'Stopped by the usage limit',
    statusError: 'Stopped by an API error',
    ageWorking: 'working',
    ageLimited: 'limit',
    ageError: 'error',
    apiError: 'API error',
    limitReset: 'Limit reset; you can continue',
    limitUntil: (time) => `Limit until ${time}`,
    limitReached: 'Usage limit reached',
    usageLimit: 'Claude usage limit',
    stopped: (titles) => `Stopped: ${titles}`,
    claudeFinished: 'Claude finished',
    claudeWaiting: 'Claude is waiting for an answer',
    waitingMany: (n, titles) => `Waiting for you: ${n} — ${titles}`,

    // ages
    now: 'now',
    minutes: (n) => `${n} min`,
    hours: (n) => `${n} h`,
    days: (n) => `${n} d`,

    // page
    search: 'Search',
    recentLabel: '7d',
    recentTitle: 'Only sessions active in the last 7 days',
    pin: 'Pin',
    pinOn: 'Pinned: the widget stays on screen even when Claude is minimized or in the background',
    pinOff: 'Not pinned: the widget hides together with Claude',
    collapse: 'Collapse',
    expand: 'Expand',
    expandTitle: (working, waiting) => `Expand — working: ${working}, waiting for you: ${waiting}`,
    detach: 'Detach',
    branch: (name) => `branch ${name}`,
    chipWaiting: 'Waiting for you',
    chipWorking: 'Working',
    chipShowAll: (label) => `${label} — show all`,
    chipShowOnly: (label) => `${label} — show only these`,
    countAll: (n) => `Sessions: ${n}`,
    countSome: (shown, all) => `Showing ${shown} of ${all}`,
    emptyNone: 'No sessions yet.',
    emptyNoMatch: 'Nothing found.',
    groupAltClick: '⌥-click: fold or unfold every group',
    restoreDetached: (n) => `Restore detached (${n})`,

    // menu bar and context menu
    showWindow: 'Show window',
    trayCounts: (working, waiting) => `Working: ${working} · Waiting for you: ${waiting}`,
    trayTooltip: (working, waiting) => `Claude Sessions — working: ${working}, waiting for you: ${waiting}`,
    pinMenu: 'Pin — do not hide with Claude',
    notifications: 'Notifications',
    language: 'Language',
    quit: 'Quit',
    openInClaude: 'Open in Claude',
    copyLink: 'Copy link',
    showInFinder: 'Show folder in Finder',
    openInTerminal: 'Open in Terminal',
    openOnGitHub: (branch) => `Pull request / branch on GitHub (${branch})`,
  };

  const ru = {
    locale: 'ru-RU',
    appName: 'Сессии Claude',
    sessions: 'Сессии',
    untitled: '(без названия)',
    noFolder: 'Без папки',

    statusWorking: 'Claude работает',
    statusWaiting: 'Claude ждёт тебя',
    statusUnread: 'Claude закончил — ты ещё не смотрел',
    statusLimited: 'Остановлено лимитом использования',
    statusError: 'Остановлено ошибкой API',
    ageWorking: 'работает',
    ageLimited: 'лимит',
    ageError: 'ошибка',
    apiError: 'Ошибка API',
    limitReset: 'Лимит сброшен — можно продолжить',
    limitUntil: (time) => `Лимит до ${time}`,
    limitReached: 'Лимит исчерпан',
    usageLimit: 'Лимит использования Claude',
    stopped: (titles) => `Остановлены: ${titles}`,
    claudeFinished: 'Claude закончил',
    claudeWaiting: 'Claude ждёт ответа',
    waitingMany: (n, titles) => `Ждут тебя: ${n} — ${titles}`,

    now: 'сейчас',
    minutes: (n) => `${n} мин`,
    hours: (n) => `${n} ч`,
    days: (n) => `${n} д`,

    search: 'Поиск',
    recentLabel: '7 д',
    recentTitle: 'Только сессии с активностью за 7 дней',
    pin: 'Закрепить',
    pinOn: 'Закреплено: виджет остаётся на экране, даже когда Claude свёрнут или не активен',
    pinOff: 'Не закреплено: виджет прячется вместе с Claude',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    expandTitle: (working, waiting) => `Развернуть — работают: ${working}, ждут тебя: ${waiting}`,
    detach: 'Открепить',
    branch: (name) => `ветка ${name}`,
    chipWaiting: 'Ждут тебя',
    chipWorking: 'Работают',
    chipShowAll: (label) => `${label} — показать все`,
    chipShowOnly: (label) => `${label} — показать только их`,
    countAll: (n) => `Сессий: ${n}`,
    countSome: (shown, all) => `Показано ${shown} из ${all}`,
    emptyNone: 'Сессий пока нет.',
    emptyNoMatch: 'Ничего не найдено.',
    groupAltClick: '⌥-клик — свернуть или развернуть все группы',
    restoreDetached: (n) => `Вернуть открепленные (${n})`,

    showWindow: 'Показать окно',
    trayCounts: (working, waiting) => `Работают: ${working} · Ждут тебя: ${waiting}`,
    trayTooltip: (working, waiting) => `Сессии Claude — работают: ${working}, ждут тебя: ${waiting}`,
    pinMenu: 'Закрепить — не прятать вместе с Claude',
    notifications: 'Уведомления',
    language: 'Язык',
    quit: 'Выход',
    openInClaude: 'Открыть в Claude',
    copyLink: 'Скопировать ссылку',
    showInFinder: 'Показать папку в Finder',
    openInTerminal: 'Открыть в Терминале',
    openOnGitHub: (branch) => `PR / ветка на GitHub (${branch})`,
  };

  // Each language's own name, for the language menu.
  const I18N = { en, ru, names: { en: 'English', ru: 'Русский' }, fallback: 'en' };

  if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
  else root.I18N = I18N;
})(typeof window !== 'undefined' ? window : this);
