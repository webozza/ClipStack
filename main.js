const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, nativeImage, Tray, Menu, systemPreferences, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const crypto = require("crypto");
const flags = require("./config");

const DEFAULT_MAX_ITEMS = flags.FREE_HISTORY_LIMIT;
const POLL_MS = 300;

const DEFAULT_HOTKEY = "CommandOrControl+Shift+V";

const store = new Store({
  name: "clipboard",
  defaults: {
    items: [],
    pinnedKeys: [],
    settings: {
      autoPasteOnCmdEnter: flags.AUTO_PASTE_ENABLED,
      pauseCapture: false,
      hotkey: DEFAULT_HOTKEY,
      maxItems: flags.FREE_HISTORY_LIMIT,
      maskSensitive: true,
      trackSource: false,
      launchAtLogin: false,
    }
  }
});

// Strip any pre-existing demo subscription state — never trust persisted
// "pro" flags from older builds since the demo activation path is gone.
if (!flags.PRO_UI_ENABLED) {
  try { store.delete("subscription"); } catch (_) {}
}

// Dev: `--reset-onboarding` clears the persisted onboarding flag so the
// next launch replays the flow.
if (process.argv.includes("--reset-onboarding")) {
  try { store.delete("hasOnboarded"); } catch (_) {}
}

let win = null;
let lastFormats = "";
let lastClipboardHash = "";
let pollTimer = null;
let rendererReady = false;
let selectedKey = null;
let previousApp = null;
let previousAppBundle = null;
let hotkeyBusy = false;

// Our own bundle ID (from package.json build.appId)
const OWN_BUNDLE_ID = "com.syed.clipboard";

function hashKey(value) {
  return crypto.createHash("sha1").update(value, "utf8").digest("hex");
}

function uniqueKey(value, ts) {
  const nonce = crypto.randomBytes(4).toString("hex");
  return hashKey(`${value}::${ts}::${nonce}`);
}

function normalizeText(t) {
  return (t || "").replace(/\r\n/g, "\n");
}

const { exec } = require("child_process");

function sendPasteKeystroke() {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      // macOS: Use AppleScript to simulate Cmd+V
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, (err) => {
        if (err) console.error("Paste keystroke error:", err);
        resolve(!err);
      });
    } else if (process.platform === "win32") {
      // Windows: Use PowerShell to simulate Ctrl+V
      exec(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`, (err) => {
        if (err) console.error("Paste keystroke error:", err);
        resolve(!err);
      });
    } else {
      // Linux: Use xdotool
      exec(`xdotool key ctrl+v`, (err) => {
        if (err) console.error("Paste keystroke error:", err);
        resolve(!err);
      });
    }
  });
}

function detectType(value) {
  const v = value.trim();
  const isUrl = /^https?:\/\/\S+$/i.test(v) || /^www\.\S+$/i.test(v);
  if (isUrl) return "link";

  const looksLikeCode =
    v.includes("{") || v.includes("}") ||
    v.includes("=>") ||
    v.includes("function ") ||
    v.includes("const ") || v.includes("let ") || v.includes("var ") ||
    v.includes("import ") || v.includes("export ") ||
    v.includes("</") ||
    (v.includes("\n") && /[;{}\[\]()]/.test(v));

  if (looksLikeCode) return "code";
  return "text";
}

function getState() {
  const items = store.get("items") || [];
  const pinnedKeys = store.get("pinnedKeys") || [];
  const snippets = store.get("snippets") || [];
  const settings = store.get("settings") || {};
  const subscription = flags.PRO_UI_ENABLED
    ? (store.get("subscription") || { plan: "free" })
    : { plan: "free" };
  const hasOnboarded = store.get("hasOnboarded") || false;
  return { items, pinnedKeys, snippets, settings, subscription, hasOnboarded, flags: getRendererFlags() };
}

function getRendererFlags() {
  return {
    PRO_UI_ENABLED: flags.PRO_UI_ENABLED,
    PRO_FEATURES_UNLOCKED: flags.PRO_FEATURES_UNLOCKED,
    SHARING_ENABLED: flags.SHARING_ENABLED,
    AUTO_PASTE_ENABLED: flags.AUTO_PASTE_ENABLED,
    IS_MAS_BUILD: flags.IS_MAS_BUILD,
    FREE_HISTORY_LIMIT: flags.FREE_HISTORY_LIMIT,
    FREE_SNIPPET_LIMIT: flags.FREE_SNIPPET_LIMIT,
    FREE_TAG_LIMIT_PER_ITEM: flags.FREE_TAG_LIMIT_PER_ITEM,
  };
}

function getOrderedItems() {
  const { items, pinnedKeys } = getState();
  const pinned = new Set(pinnedKeys || []);
  return [...(items || [])].sort((a, b) => {
    const ap = pinned.has(a.key) ? 1 : 0;
    const bp = pinned.has(b.key) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.ts || 0) - (a.ts || 0);
  });
}

function setSelection(key) {
  selectedKey = key || null;
  if (!win || win.isDestroyed() || !rendererReady) return;
  win.webContents.send("selection:update", { key: selectedKey });
}

function setState(partial) {
  if (partial.items) store.set("items", partial.items);
  if (partial.pinnedKeys) store.set("pinnedKeys", partial.pinnedKeys);
  if (partial.settings) store.set("settings", partial.settings);
  sendState();
}
function sendState() {
  if (!win || win.isDestroyed()) return;
  if (!rendererReady) return;

  const state = getState();
  win.webContents.send("state:update", state);
}


function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 800,
    show: false,
    alwaysOnTop: false,
    focusable: true,
    acceptFirstMouse: true,
    backgroundColor: "#0C1019",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));

  win.webContents.on("did-finish-load", () => {
    rendererReady = true;
    sendState();
  });


  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}


async function capturePreviousApp() {
  if (process.platform !== "darwin") return;
  if (!flags.SOURCE_APP_PROBE_ENABLED) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 1000);
    const script = [
      `tell application "System Events"`,
      `  set p to first process whose frontmost is true`,
      `  set n to name of p`,
      `  set b to bundle identifier of p`,
      `  return n & "|" & b`,
      `end tell`,
    ].join("\n");
    exec(`osascript << 'AS'\n${script}\nAS`, (err, stdout) => {
      clearTimeout(timer);
      if (!err && stdout.trim()) {
        const parts = stdout.trim().split("|");
        previousApp = parts[0]?.trim() || null;
        previousAppBundle = parts[1]?.trim() || null;
      }
      resolve();
    });
  });
}

async function showWindow() {
  if (!win) return;
  if (!win.isVisible()) {
    win.show();
    win.focus();
  }
  setSelection(null);
  sendState();
}

function hideWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
}

async function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) hideWindow();
  else await showWindow();
}

// Shared handler — guards against double-fire from key repeat
const handleHotkey = async () => {
  if (hotkeyBusy) return;
  hotkeyBusy = true;
  try {
    if (!win?.isVisible()) await capturePreviousApp();
    await toggleWindow();
  } finally {
    setTimeout(() => { hotkeyBusy = false; }, 400);
  }
};

let registeredHotkeys = [];

function registerHotkey() {
  // Unregister previous hotkeys
  registeredHotkeys.forEach(key => {
    try { globalShortcut.unregister(key); } catch (_) {}
  });
  registeredHotkeys = [];

  const settings = store.get("settings") || {};
  const hotkey = settings.hotkey || DEFAULT_HOTKEY;

  globalShortcut.register(hotkey, handleHotkey);
  registeredHotkeys.push(hotkey);

  // Also register Control+Shift+V as fallback if the primary isn't already that
  if (hotkey !== "Control+Shift+V" && hotkey !== "CommandOrControl+Shift+V") {
    try {
      globalShortcut.register("Control+Shift+V", handleHotkey);
      registeredHotkeys.push("Control+Shift+V");
    } catch (_) {}
  } else {
    try {
      globalShortcut.register("Control+Shift+V", handleHotkey);
      registeredHotkeys.push("Control+Shift+V");
    } catch (_) {}
  }

  const okUp = globalShortcut.register("CommandOrControl+Shift+Up", () => {
    if (!win || !win.isVisible()) return;
    const ordered = getOrderedItems();
    if (!ordered.length) return;
    const idx = Math.max(0, ordered.findIndex(i => i.key === selectedKey));
    setSelection(ordered[Math.max(0, idx - 1)].key);
  });
  registeredHotkeys.push("CommandOrControl+Shift+Up");

  globalShortcut.register("CommandOrControl+Shift+Down", () => {
    if (!win || !win.isVisible()) return;
    const ordered = getOrderedItems();
    if (!ordered.length) return;
    const idx = Math.max(0, ordered.findIndex(i => i.key === selectedKey));
    setSelection(ordered[Math.min(ordered.length - 1, idx + 1)].key);
  });
  registeredHotkeys.push("CommandOrControl+Shift+Down");
}



function startClipboardPolling() {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(() => {
    const settings = store.get("settings") || {};
    if (settings.pauseCapture) return;

    const formats = clipboard.availableFormats();
    const formatsStr = formats.join(", ");
    if (formatsStr !== lastFormats) lastFormats = formatsStr;

    const text = clipboard.readText() || "";
    const image = clipboard.readImage();
    const imageEmpty = image.isEmpty();
    const imageSize = image.getSize();

    let imageHash = "";
    let imageDataUrl = null;

    // Native image — capped at MAX_IMAGE_BYTES so the local store doesn't bloat.
    if (!imageEmpty && imageSize.width > 10 && imageSize.height > 10) {
      const pngBuffer = image.toPNG();
      if (pngBuffer.length <= flags.MAX_IMAGE_BYTES) {
        imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
        imageDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
      }
    }

    // HTML embedded base64 — accept these (still local), skip remote URLs.
    let htmlImageDataUrl = null;
    let htmlImageHash = "";
    if (!imageDataUrl && formats.includes("text/html")) {
      try {
        const html = clipboard.readHTML();
        const base64Match = html.match(/data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/);
        if (base64Match) {
          const base64Data = base64Match[2];
          if (base64Data.length * 0.75 <= flags.MAX_IMAGE_BYTES) {
            htmlImageDataUrl = `data:image/${base64Match[1]};base64,${base64Data}`;
            htmlImageHash = crypto.createHash("sha1").update(base64Data).digest("hex");
          }
        }
      } catch (_) {}
    }

    const combinedHash = crypto.createHash("sha1")
      .update(text)
      .update(imageHash || htmlImageHash || "")
      .digest("hex");

    if (combinedHash === lastClipboardHash) return;
    lastClipboardHash = combinedHash;

    const hasImage = imageDataUrl || htmlImageDataUrl;
    const hasText = text && text.trim().length > 0;

    if (hasImage && hasText) {
      const finalImageUrl = imageDataUrl || htmlImageDataUrl;
      if (finalImageUrl) upsertImageItem(finalImageUrl);
      upsertItem(text);
      return;
    }

    if (hasImage) {
      const finalImageUrl = imageDataUrl || htmlImageDataUrl;
      if (finalImageUrl) {
        upsertImageItem(finalImageUrl);
        return;
      }
    }

    // Image file dragged in from Finder — local file, no network.
    if (process.platform === "darwin" && formats.includes("public.file-url")) {
      try {
        const fileUrl = clipboard.read("public.file-url");
        if (fileUrl && fileUrl.startsWith("file://")) {
          const filePath = decodeURIComponent(fileUrl.replace("file://", ""));
          const ext = path.extname(filePath).toLowerCase();
          const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"];

          if (imageExts.includes(ext) && fs.existsSync(filePath)) {
            const img = nativeImage.createFromPath(filePath);
            if (!img.isEmpty()) {
              const size = img.getSize();
              if (size.width > 10 && size.height > 10) {
                const pngBuffer = img.toPNG();
                if (pngBuffer.length <= flags.MAX_IMAGE_BYTES) {
                  const fileImageUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
                  upsertImageItem(fileImageUrl);
                  return;
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    if (hasText) {
      upsertItem(text);
      return;
    }
  }, POLL_MS);
}

function isExcludedApp(appName) {
  if (!appName) return false;
  const excluded = (store.get("settings")?.excludedApps || []);
  return excluded.some(a => appName.toLowerCase().includes(a.toLowerCase()));
}

function getMaxItems() {
  const max = store.get("settings")?.maxItems;
  if (!max || max === 0) return 9999;
  return max;
}

function upsertItem(valueRaw) {
  const value = normalizeText(valueRaw).trimEnd();
  if (!value) return;
  if (isExcludedApp(previousApp)) return;

  const now = Date.now();
  const key = uniqueKey(value, now);
  const sensitive = isSensitiveServer(value);

  const items = store.get("items") || [];
  items.unshift({
    key,
    value,
    ts: now,
    type: detectType(value),
    hits: 1,
    source: previousApp || null,
    sensitive,
    tags: [],
  });

  const maxItems = getMaxItems();
  if (items.length > maxItems) items.length = maxItems;

  store.set("items", items);
  sendState();
}

function isSensitiveServer(value) {
  const patterns = [
    /sk-[a-zA-Z0-9]{20,}/,
    /ghp_[a-zA-Z0-9]{30,}/,
    /AKIA[A-Z0-9]{16}/,
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /password\s*[=:]\s*\S+/i,
    /secret\s*[=:]\s*\S+/i,
    /api[_-]?key\s*[=:]\s*\S+/i,
    // DB / broker / queue connection URLs with embedded credentials
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^\s:]+:[^\s@]+@/i,
  ];
  return patterns.some(re => re.test(value));
}

function upsertImageItem(dataUrl) {
  if (!dataUrl) return;
  if (isExcludedApp(previousApp)) return;

  const now = Date.now();
  const key = uniqueKey(dataUrl, now);

  const items = store.get("items") || [];
  items.unshift({
    key,
    value: dataUrl,
    ts: now,
    type: "image",
    hits: 1,
    source: previousApp || null,
    tags: [],
  });

  const maxItems = getMaxItems();
  if (items.length > maxItems) items.length = maxItems;

  store.set("items", items);
  sendState();
}

// ---- IPC ----
ipcMain.handle("state:get", () => getState());

ipcMain.handle("window:hide", () => {
  hideWindow();
  return true;
});

ipcMain.handle("history:clear", () => {
  store.set("items", []);
  sendState();
  return true;
});

ipcMain.handle("item:delete", (_e, key) => {
  const items = store.get("items") || [];
  store.set("items", items.filter(i => i.key !== key));
  // also unpin if pinned
  const pinnedKeys = new Set(store.get("pinnedKeys") || []);
  pinnedKeys.delete(key);
  store.set("pinnedKeys", Array.from(pinnedKeys));
  sendState();
  return true;
});

ipcMain.handle("item:togglePin", (_e, key) => {
  const pinnedKeys = new Set(store.get("pinnedKeys") || []);
  if (pinnedKeys.has(key)) pinnedKeys.delete(key);
  else pinnedKeys.add(key);
  store.set("pinnedKeys", Array.from(pinnedKeys));
  sendState();
  return true;
});

ipcMain.handle("item:copyAndPaste", async (_e, key) => {
  const { items } = getState();
  const item = items.find(i => i.key === key);
  if (!item) return false;

  // Handle image vs text
  if (item.type === "image") {
    try {
      const img = nativeImage.createFromDataURL(item.value);
      if (img.isEmpty()) return false;
      clipboard.clear();
      clipboard.writeImage(img);
      const pngBuffer = img.toPNG();
      const imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
      lastClipboardHash = crypto.createHash("sha1").update("").update(imageHash).digest("hex");
    } catch (_) {
      return false;
    }
  } else {
    clipboard.writeText(item.value);
    lastClipboardHash = crypto.createHash("sha1").update(item.value).update("").digest("hex");
  }
  hideWindow();

  // Sandboxed (MAS) builds can't synthesize keystrokes to other apps.
  // Just copy and let the user press ⌘V themselves.
  if (!flags.AUTO_PASTE_ENABLED) return true;

  // Give the window time to fully hide before activating the target app.
  await new Promise((r) => setTimeout(r, 220));

  if (process.platform === "darwin") {
    // ── Self-detection via bundle ID (reliable across dev & production) ────
    // Bundle IDs are unique: our app = com.syed.clipboard,
    // VS Code = com.microsoft.VSCode, Antigravity has its own ID, etc.
    // This correctly handles ALL Electron-based apps without false positives.
    const isSelf = !previousApp
      || previousAppBundle === OWN_BUNDLE_ID
      || (!previousAppBundle && previousApp === app.getName());

    if (isSelf) return false;

    // ── Universal Hardware Paste ──────────────────────────────────────────
    // Chromium/Electron-based editors (VS Code, Cursor, Antigravity) often 
    // ignore macOS soft `keystroke "v"`. Synthesizing the physical hardware 
    // V key (`key code 9`) bypasses this issue and works perfectly in ALL 
    // editors natively, without needing to hardcode specific app names.
    const activateLine = previousAppBundle
      ? `tell application id "${previousAppBundle}" to activate`
      : `tell application "${previousApp}" to activate`;

    const script = [
      `try`,
      `  ${activateLine}`,
      `end try`,
      `delay 0.25`,
      `tell application "System Events" to key code 9 using command down`,
    ].join("\n");

    return new Promise((resolve) => {
      exec(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, (err) => {
        if (err) {
          console.error("Paste failed, falling back to keystroke:", err.message);
          exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, () => resolve(true));
        } else {
          resolve(true);
        }
      });
    });
  }

  // Windows / Linux
  return await sendPasteKeystroke();
});

ipcMain.handle("item:copy", async (_e, key) => {
  const { items } = getState();
  const item = items.find(i => i.key === key);
  if (!item) return false;

  // Handle image vs text
  if (item.type === "image") {
    try {
      const img = nativeImage.createFromDataURL(item.value);
      if (img.isEmpty()) return false;
      clipboard.clear();
      clipboard.writeImage(img);
      const pngBuffer = img.toPNG();
      const imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
      lastClipboardHash = crypto.createHash("sha1").update("").update(imageHash).digest("hex");
    } catch (_) {
      return false;
    }
  } else {
    clipboard.writeText(item.value);
    lastClipboardHash = crypto.createHash("sha1").update(item.value).update("").digest("hex");
  }
  return true;
});

ipcMain.handle("item:copyText", (_e, text) => {
  clipboard.writeText(text);
  // Update tracking to prevent re-capture
  lastClipboardHash = crypto.createHash("sha1").update(text).update("").digest("hex");
  return true;
});

ipcMain.handle("settings:update", (_e, patch) => {
  const settings = store.get("settings") || {};
  const next = { ...settings, ...patch };
  store.set("settings", next);

  sendState();
  return next;
});

ipcMain.handle("settings:updateHotkey", (_e, accelerator) => {
  if (!accelerator || typeof accelerator !== "string") {
    return { success: false, error: "Invalid shortcut" };
  }
  try {
    // Validate by trying to register (then immediately unregister)
    const testOk = globalShortcut.register(accelerator, () => {});
    globalShortcut.unregister(accelerator);
    if (!testOk) return { success: false, error: "Could not register shortcut" };

    // Save and re-register
    const settings = store.get("settings") || {};
    settings.hotkey = accelerator;
    store.set("settings", settings);

    registerHotkey();
    sendState();
    return { success: true, hotkey: accelerator };
  } catch (err) {
    console.error("Failed to update hotkey:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("settings:resetHotkey", () => {
  const settings = store.get("settings") || {};
  settings.hotkey = DEFAULT_HOTKEY;
  store.set("settings", settings);
  registerHotkey();
  sendState();
  return { success: true, hotkey: DEFAULT_HOTKEY };
});

ipcMain.handle("capture:togglePause", () => {
  const settings = store.get("settings") || {};
  settings.pauseCapture = !settings.pauseCapture;
  store.set("settings", settings);
  sendState();
  return settings.pauseCapture;
});

// ── NEW IPC HANDLERS ────────────────────────

ipcMain.handle("item:edit", (_e, key, newValue) => {
  const items = store.get("items") || [];
  const idx = items.findIndex(i => i.key === key);
  if (idx !== -1) {
    items[idx].value = newValue;
    items[idx].type = detectType(newValue);
    items[idx].sensitive = isSensitiveServer(newValue);
    store.set("items", items);
  }
  // Also check snippets
  const snippets = store.get("snippets") || [];
  const si = snippets.findIndex(i => i.key === key);
  if (si !== -1) { snippets[si].value = newValue; store.set("snippets", snippets); }
  sendState();
  return true;
});

ipcMain.handle("item:deleteMany", (_e, keys) => {
  const keySet = new Set(keys);
  const items = store.get("items") || [];
  store.set("items", items.filter(i => !keySet.has(i.key)));
  const pinnedKeys = (store.get("pinnedKeys") || []).filter(k => !keySet.has(k));
  store.set("pinnedKeys", pinnedKeys);
  sendState();
  return true;
});

ipcMain.handle("item:setTags", (_e, key, tags) => {
  const items = store.get("items") || [];
  const idx = items.findIndex(i => i.key === key);
  if (idx !== -1) { items[idx].tags = tags; store.set("items", items); }
  const snippets = store.get("snippets") || [];
  const si = snippets.findIndex(i => i.key === key);
  if (si !== -1) { snippets[si].tags = tags; store.set("snippets", snippets); }
  sendState();
  return true;
});

ipcMain.handle("item:convertToSnippet", (_e, key, name) => {
  const items = store.get("items") || [];
  const item = items.find(i => i.key === key);
  if (!item) return false;
  const snippets = store.get("snippets") || [];
  if (!snippets.find(s => s.key === key)) {
    snippets.unshift({ ...item, snippetName: name, savedAt: Date.now() });
    store.set("snippets", snippets);
  }
  sendState();
  return true;
});

ipcMain.handle("item:deleteSnippet", (_e, key) => {
  const snippets = store.get("snippets") || [];
  store.set("snippets", snippets.filter(i => i.key !== key));
  sendState();
  return true;
});

ipcMain.handle("history:export", async () => {
  const { items } = getState();
  const { filePath } = await dialog.showSaveDialog(win, {
    title: "Export Clipboard History",
    defaultPath: `clipboard-history-${Date.now()}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (filePath) {
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf8");
    return true;
  }
  return false;
});

ipcMain.handle("stats:get", () => {
  const items = store.get("items") || [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return {
    total: items.length,
    today: items.filter(i => i.ts >= today.getTime()).length,
    byType: items.reduce((acc, i) => { acc[i.type] = (acc[i.type] || 0) + 1; return acc; }, {}),
    topItems: [...items].sort((a, b) => (b.hits || 1) - (a.hits || 1)).slice(0, 5),
  };
});

ipcMain.handle("app:setOnboarded", () => {
  store.set("hasOnboarded", true);
  return true;
});

ipcMain.handle("app:resetOnboarding", () => {
  store.delete("hasOnboarded");
  return true;
});

ipcMain.handle("app:setLoginItem", (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return true;
});

ipcMain.handle("app:openExternal", (_e, url) => {
  // Only allow http/https schemes — defense against shell.openExternal abuse.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch (_) {
    return false;
  }
  shell.openExternal(url);
  return true;
});

ipcMain.handle("app:getFlags", () => getRendererFlags());

ipcMain.handle("app:openA11ySettings", () => {
  if (process.platform !== "darwin") return false;
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  return true;
});

function pruneOldItems() {
  if (!flags.HISTORY_RETENTION_DAYS) return;
  const cutoff = Date.now() - flags.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const items = store.get("items") || [];
  const pinned = new Set(store.get("pinnedKeys") || []);
  const kept = items.filter(i => pinned.has(i.key) || (i.ts || 0) >= cutoff);
  if (kept.length !== items.length) store.set("items", kept);
}

// ---- App lifecycle ----
app.whenReady().then(async () => {
  // Don't auto-prompt for Accessibility on launch — only when the user
  // first triggers a feature that needs it. Passing `false` here just reads
  // the current trust state without showing a prompt.
  if (process.platform === "darwin" && flags.AUTO_PASTE_ENABLED) {
    systemPreferences.isTrustedAccessibilityClient(false);
  }

  // Set dock icon in dev mode — packaged builds use build/icon.icns instead.
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, "build", "icon.png")); } catch (_) {}
  }

  pruneOldItems();
  createWindow();
  registerHotkey();
  createTray();
  startClipboardPolling();
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    showWindow();
  }
});

// Keep app running when window is closed (minimize to tray)
app.on("window-all-closed", (e) => {
  // Don't quit on macOS - keep running in tray
  if (process.platform === "darwin") {
    e.preventDefault();
  }
});
let tray = null;

function createTray() {
  // Use a cleaner SVG that works better as a template
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`.trim();

  const icon = nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")
  );

  // CRITICAL: This makes the icon automatically switch white/black based on menu bar theme
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("Clipboard History");

  tray.on("click", () => toggleWindow());

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show/Hide", click: () => toggleWindow() },
    { type: "separator" },
    {
      label: "Quit", click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.on("right-click", () => {
    tray.popUpContextMenu(contextMenu);
  });
}

