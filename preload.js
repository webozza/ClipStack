const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipAPI", {
  // State
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb) => ipcRenderer.on("state:update", (_e, s) => cb(s)),
  onSelection: (cb) => ipcRenderer.on("selection:update", (_e, sel) => cb(sel)),

  // History
  clearHistory: () => ipcRenderer.invoke("history:clear"),

  // Items
  deleteItem: (key) => ipcRenderer.invoke("item:delete", key),
  deleteItems: (keys) => ipcRenderer.invoke("item:deleteMany", keys),
  togglePin: (key) => ipcRenderer.invoke("item:togglePin", key),
  copyItem: (key) => ipcRenderer.invoke("item:copy", key),
  copyAndPaste: (key) => ipcRenderer.invoke("item:copyAndPaste", key),
  editItem: (key, value) => ipcRenderer.invoke("item:edit", key, value),
  setTags: (key, tags) => ipcRenderer.invoke("item:setTags", key, tags),
  convertToSnippet: (key, name) => ipcRenderer.invoke("item:convertToSnippet", key, name),
  deleteSnippet: (key) => ipcRenderer.invoke("item:deleteSnippet", key),

  // Settings
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  togglePause: () => ipcRenderer.invoke("capture:togglePause"),
  setLoginItem: (enabled) => ipcRenderer.invoke("app:setLoginItem", enabled),

  // Subscription
  activateLicense: (key) => ipcRenderer.invoke("subscription:activate", key),

  // Onboarding
  setOnboarded: () => ipcRenderer.invoke("app:setOnboarded"),

  // Export
  exportHistory: () => ipcRenderer.invoke("history:export"),

  // System
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),

  // Stats
  getStats: () => ipcRenderer.invoke("stats:get"),
});


