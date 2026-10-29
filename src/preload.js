'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('sessionsWidget', {
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  openSession: (id) => ipcRenderer.invoke('sessions:open', id),
  hideSession: (id) => ipcRenderer.invoke('sessions:hide', id),
  showSessionMenu: (id) => ipcRenderer.invoke('sessions:menu', id),
  resetHidden: () => ipcRenderer.invoke('sessions:reset'),
  undo: () => ipcRenderer.invoke('undo'),
  getFlags: () => ipcRenderer.invoke('flags:get'),
  setPinned: (pinned) => ipcRenderer.invoke('window:set-pinned', pinned),
  setCollapsed: (collapsed, options) => ipcRenderer.invoke('window:set-collapsed', collapsed, options),
  finishCollapse: () => ipcRenderer.invoke('window:finish-collapse'),
  setMiniHover: (over) => ipcRenderer.invoke('window:mini-hover', over),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onSessionsUpdated: (cb) => subscribe('sessions:updated', cb),
  onFlagsUpdated: (cb) => subscribe('flags:updated', cb),
  onFocusSearch: (cb) => subscribe('ui:focus-search', cb),
});
