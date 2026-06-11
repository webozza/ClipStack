const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipAPI", {
  // State
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb) => ipcRenderer.on("state:update", (_e, s) => cb(s)),
  onSelection: (cb) => ipcRenderer.on("selection:update", (_e, sel) => cb(sel)),

  // Build / feature flags
  getFlags: () => ipcRenderer.invoke("app:getFlags"),

  // History
  clearHistory: () => ipcRenderer.invoke("history:clear"),

  // Items
  deleteItem: (key) => ipcRenderer.invoke("item:delete", key),
  deleteItems: (keys) => ipcRenderer.invoke("item:deleteMany", keys),
  togglePin: (key) => ipcRenderer.invoke("item:togglePin", key),
  copyItem: (key) => ipcRenderer.invoke("item:copy", key),
  copyText: (text) => ipcRenderer.invoke("item:copyText", text),
  copyAndPaste: (key) => ipcRenderer.invoke("item:copyAndPaste", key),
  editItem: (key, value) => ipcRenderer.invoke("item:edit", key, value),
  setTags: (key, tags) => ipcRenderer.invoke("item:setTags", key, tags),
  convertToSnippet: (key, name) => ipcRenderer.invoke("item:convertToSnippet", key, name),
  deleteSnippet: (key) => ipcRenderer.invoke("item:deleteSnippet", key),

  // Settings
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  updateHotkey: (accelerator) => ipcRenderer.invoke("settings:updateHotkey", accelerator),
  resetHotkey: () => ipcRenderer.invoke("settings:resetHotkey"),
  togglePause: () => ipcRenderer.invoke("capture:togglePause"),
  setLoginItem: (enabled) => ipcRenderer.invoke("app:setLoginItem", enabled),

  // Onboarding
  setOnboarded: () => ipcRenderer.invoke("app:setOnboarded"),
  resetOnboarding: () => ipcRenderer.invoke("app:resetOnboarding"),

  // Export
  exportHistory: () => ipcRenderer.invoke("history:export"),

  // System
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  openA11ySettings: () => ipcRenderer.invoke("app:openA11ySettings"),

  // Stats
  getStats: () => ipcRenderer.invoke("stats:get"),
});
