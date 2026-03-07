const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, nativeImage, Tray, Menu, nativeTheme, net, systemPreferences, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");
const crypto = require("crypto");

const DEFAULT_MAX_ITEMS = 200;
const POLL_MS = 300;

const store = new Store({
  name: "clipboard",
  defaults: {
    items: [],              // [{ key, value, ts, type, hits }]
    pinnedKeys: [],         // [key]
    settings: {
      autoPasteOnCmdEnter: true,
      pauseCapture: false,
      theme: "system"       // "system" | "light" | "dark"
    }
  }
});

let win = null;
let lastFormats = "";
let lastClipboardHash = "";
let pollTimer = null;
let rendererReady = false;
let selectedKey = null;
let previousApp = null;       // display name of last focused app
let previousAppBundle = null; // bundle ID of last focused app (most reliable)
let hotkeyBusy = false;       // mutex — prevents double-toggle from key repeat

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
  const subscription = store.get("subscription") || { plan: "free" };
  const hasOnboarded = store.get("hasOnboarded") || false;
  return { items, pinnedKeys, snippets, settings, subscription, hasOnboarded };
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
  console.log("➡️ sendState items:", state.items.length);
  win.webContents.send("state:update", state);
}


function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 800,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    acceptFirstMouse: true,
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
    console.log("✅ Renderer ready");
    sendState();
    // App starts silently in the tray — user opens via Ctrl+Shift+V or tray icon.
    // Do NOT auto-show here to avoid stealing focus on startup.
  });

  // Hide window instead of closing (keep app running in tray)
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}


async function capturePreviousApp() {
  if (process.platform !== "darwin") return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 1000);
    // Get BOTH the display name AND the bundle identifier.
    // Bundle ID is unique per app, so it correctly distinguishes our Electron
    // process from VS Code, Antigravity, and other Electron-based apps.
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
        console.log(`📍 Previous app: "${previousApp}" [${previousAppBundle}]`);
      }
      resolve();
    });
  });
}

async function showWindow() {
  if (!win) return;
  if (!win.isVisible()) {
    win.show();
    win.setAlwaysOnTop(true, "status");
    win.focus();
  }
  const ordered = getOrderedItems();
  setSelection(ordered[0] ? ordered[0].key : null);
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

function registerHotkey() {
  // Shared handler — guards against double-fire from key repeat
  const handleHotkey = async () => {
    if (hotkeyBusy) return; // already handling a press, ignore
    hotkeyBusy = true;
    try {
      if (!win?.isVisible()) await capturePreviousApp();
      await toggleWindow();
    } finally {
      // Release after a short cooldown so rapid presses are ignored
      setTimeout(() => { hotkeyBusy = false; }, 400);
    }
  };

  // CommandOrControl+Shift+V  → Cmd+Shift+V on macOS, Ctrl+Shift+V on Win/Linux
  const ok1 = globalShortcut.register("CommandOrControl+Shift+V", handleHotkey);
  // Control+Shift+V            → Ctrl+Shift+V on macOS explicitly
  const ok2 = globalShortcut.register("Control+Shift+V", handleHotkey);

  const okUp = globalShortcut.register("CommandOrControl+Shift+Up", () => {
    if (!win || !win.isVisible()) return;
    const ordered = getOrderedItems();
    if (!ordered.length) return;
    const idx = Math.max(0, ordered.findIndex(i => i.key === selectedKey));
    setSelection(ordered[Math.max(0, idx - 1)].key);
  });

  const okDown = globalShortcut.register("CommandOrControl+Shift+Down", () => {
    if (!win || !win.isVisible()) return;
    const ordered = getOrderedItems();
    if (!ordered.length) return;
    const idx = Math.max(0, ordered.findIndex(i => i.key === selectedKey));
    setSelection(ordered[Math.min(ordered.length - 1, idx + 1)].key);
  });

  console.log("Registered hotkeys:", { ok1, ok2, okUp, okDown });
}



function startClipboardPolling() {
  console.log("✅ Clipboard polling started");

  if (pollTimer) clearInterval(pollTimer);

  let debugCounter = 0;
  pollTimer = setInterval(() => {
    // Check if capture is paused
    const settings = store.get("settings") || {};
    if (settings.pauseCapture) return;

    // Check available formats
    const formats = clipboard.availableFormats();
    const formatsStr = formats.join(", ");

    // Debug: log when clipboard formats change
    debugCounter++;
    if (formatsStr !== lastFormats) {
      console.log(`📋 Clipboard changed! Formats: ${formatsStr || "(empty)"}`);
      lastFormats = formatsStr;
    }

    // Create a combined hash of all clipboard content to detect changes
    const text = clipboard.readText() || "";
    const image = clipboard.readImage();
    const imageEmpty = image.isEmpty();
    const imageSize = image.getSize();

    let imageHash = "";
    let imageDataUrl = null;

    // Get image data if present
    if (!imageEmpty && imageSize.width > 10 && imageSize.height > 10) {
      const pngBuffer = image.toPNG();
      imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
      imageDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    }

    // Check for image in HTML (Google Docs, etc.)
    let htmlImageDataUrl = null;
    let htmlImageHash = "";
    if (!imageDataUrl && formats.includes("text/html")) {
      try {
        const html = clipboard.readHTML();
        const base64Match = html.match(/data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/);
        if (base64Match) {
          const mimeType = base64Match[1];
          const base64Data = base64Match[2];
          htmlImageDataUrl = `data:image/${mimeType};base64,${base64Data}`;
          htmlImageHash = crypto.createHash("sha1").update(base64Data).digest("hex");
        } else {
          // Check for image URL
          const imgSrcMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
          if (imgSrcMatch && imgSrcMatch[1] && !imgSrcMatch[1].startsWith("data:")) {
            htmlImageHash = crypto.createHash("sha1").update(imgSrcMatch[1]).digest("hex");
          }
        }
      } catch (err) {
        // Ignore HTML parsing errors
      }
    }

    // Combine all content into a single hash to prevent infinite loops
    const combinedHash = crypto.createHash("sha1")
      .update(text)
      .update(imageHash || htmlImageHash || "")
      .digest("hex");

    // Skip if nothing changed
    if (combinedHash === lastClipboardHash) {
      return;
    }

    console.log(`🔄 New clipboard content detected`);
    lastClipboardHash = combinedHash;

    // Determine what to capture
    const hasImage = imageDataUrl || htmlImageDataUrl;
    const hasText = text && text.trim().length > 0;

    // If we have both image and text, save them as separate items
    if (hasImage && hasText) {
      console.log(`📋 Clipboard has both image and text`);

      // Save image
      const finalImageUrl = imageDataUrl || htmlImageDataUrl;
      if (finalImageUrl) {
        console.log(`🖼️ Saving image: ${imageSize.width}x${imageSize.height}`);
        upsertImageItem(finalImageUrl);
      }

      // Save text
      console.log(`📝 Saving text: ${text.slice(0, 60)}...`);
      upsertItem(text);
      return;
    }

    // Just image
    if (hasImage) {
      const finalImageUrl = imageDataUrl || htmlImageDataUrl;
      if (finalImageUrl) {
        console.log(`🖼️ New clipboard image: ${imageSize.width}x${imageSize.height}`);
        upsertImageItem(finalImageUrl);
        return;
      }
    }

    // Check for image URL in HTML that needs fetching
    if (!hasImage && formats.includes("text/html")) {
      try {
        const html = clipboard.readHTML();
        const imgSrcMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (imgSrcMatch && imgSrcMatch[1] && !imgSrcMatch[1].startsWith("data:")) {
          const imgUrl = imgSrcMatch[1];
          console.log(`🌐 Found image URL in HTML: ${imgUrl}`);
          fetchImageFromUrl(imgUrl);
          // Don't return - also check for text
        }
      } catch (err) {
        // Ignore
      }
    }

    // Check for image file from Finder (macOS)
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
                const fileImageUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
                console.log(`🖼️ New image file: ${filePath} (${size.width}x${size.height})`);
                upsertImageItem(fileImageUrl);
                return;
              }
            }
          }
        }
      } catch (err) {
        console.error("Error reading file from clipboard:", err);
      }
    }

    // Just text
    if (hasText) {
      console.log(`📋 New clipboard text: ${text.slice(0, 60)}`);
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
  if (isExcludedApp(previousApp)) {
    console.log("Skipping capture from excluded app:", previousApp);
    return;
  }

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
  ];
  return patterns.some(re => re.test(value));
}

async function fetchImageFromUrl(url) {
  try {
    // Handle protocol-relative URLs
    if (url.startsWith("//")) {
      url = "https:" + url;
    }

    console.log(`⬇️ Fetching image from: ${url}`);

    const request = net.request(url);
    const chunks = [];

    request.on("response", (response) => {
      const contentType = response.headers["content-type"];
      if (!contentType || !contentType[0].startsWith("image/")) {
        console.log(`❌ Not an image: ${contentType}`);
        return;
      }

      response.on("data", (chunk) => {
        chunks.push(chunk);
      });

      response.on("end", () => {
        try {
          const buffer = Buffer.concat(chunks);
          const img = nativeImage.createFromBuffer(buffer);

          if (!img.isEmpty()) {
            const size = img.getSize();
            if (size.width > 10 && size.height > 10) {
              const pngBuffer = img.toPNG();
              const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
              console.log(`✅ Fetched image: ${size.width}x${size.height}`);
              upsertImageItem(dataUrl);
            }
          }
        } catch (err) {
          console.error("Error processing fetched image:", err);
        }
      });
    });

    request.on("error", (err) => {
      console.error("Error fetching image:", err);
    });

    request.end();
  } catch (err) {
    console.error("Error in fetchImageFromUrl:", err);
  }
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
      if (img.isEmpty()) {
        console.error("Failed to create image from data URL");
        return false;
      }
      clipboard.clear();
      clipboard.writeImage(img);
      // Update tracking to prevent re-capture
      const pngBuffer = img.toPNG();
      const imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
      lastClipboardHash = crypto.createHash("sha1").update("").update(imageHash).digest("hex");
      console.log("✅ Image copied to clipboard");
    } catch (err) {
      console.error("Error copying image:", err);
      return false;
    }
  } else {
    clipboard.writeText(item.value);
    // Update tracking to prevent re-capture
    lastClipboardHash = crypto.createHash("sha1").update(item.value).update("").digest("hex");
  }
  hideWindow();

  // Give the window time to fully hide before activating the target app.
  // Without this, Cmd+V fires while ClipStack still owns the focus.
  await new Promise((r) => setTimeout(r, 220));

  if (process.platform === "darwin") {
    // ── Self-detection via bundle ID (reliable across dev & production) ────
    // Bundle IDs are unique: our app = com.syed.clipboard,
    // VS Code = com.microsoft.VSCode, Antigravity has its own ID, etc.
    // This correctly handles ALL Electron-based apps without false positives.
    const isSelf = !previousApp
      || previousAppBundle === OWN_BUNDLE_ID     // matched by bundle ID (reliable)
      || (!previousAppBundle && previousApp === app.getName()); // fallback name match

    if (isSelf) {
      console.log("Skipping — previousApp is self:", previousApp, previousAppBundle);
      return false; // nothing to paste to
    }

    console.log("Pasting to app:", previousApp, "[", previousAppBundle, "]");

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
      if (img.isEmpty()) {
        console.error("Failed to create image from data URL");
        return false;
      }
      clipboard.clear();
      clipboard.writeImage(img);
      // Update tracking to prevent re-capture
      const pngBuffer = img.toPNG();
      const imageHash = crypto.createHash("sha1").update(pngBuffer).digest("hex");
      lastClipboardHash = crypto.createHash("sha1").update("").update(imageHash).digest("hex");
      console.log("✅ Image copied to clipboard");
    } catch (err) {
      console.error("Error copying image:", err);
      return false;
    }
  } else {
    clipboard.writeText(item.value);
    // Update tracking to prevent re-capture
    lastClipboardHash = crypto.createHash("sha1").update(item.value).update("").digest("hex");
  }
  return true;
});

ipcMain.handle("settings:update", (_e, patch) => {
  const settings = store.get("settings") || {};
  const next = { ...settings, ...patch };
  store.set("settings", next);

  if (next.theme === "light") nativeTheme.themeSource = "light";
  else if (next.theme === "dark") nativeTheme.themeSource = "dark";
  else nativeTheme.themeSource = "system";

  sendState();
  return next;
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

const LICENSE_KEYS = {
  "CLIPSTACK-PRO-DEMO": "pro",
  "CLIPSTACK-TEAM-DEMO": "team",
};

ipcMain.handle("subscription:activate", (_e, key) => {
  const plan = LICENSE_KEYS[key.trim().toUpperCase()];
  if (!plan) return { success: false };
  store.set("subscription", { plan, activatedAt: Date.now(), expiresAt: null });
  sendState();
  return { success: true, plan };
});

ipcMain.handle("app:setOnboarded", () => {
  store.set("hasOnboarded", true);
  return true;
});

ipcMain.handle("app:setLoginItem", (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return true;
});

ipcMain.handle("app:openExternal", (_e, url) => {
  shell.openExternal(url);
  return true;
});

// ---- App lifecycle ----
app.whenReady().then(async () => {
  // On macOS, explicitly check/request accessibility permissions
  // The 'true' argument triggers the system prompt if not already granted
  if (process.platform === "darwin") {
    const isTrusted = systemPreferences.isTrustedAccessibilityClient(true);
    console.log("Accessibility Trusted:", isTrusted);
    if (!isTrusted) {
      console.log("⚠️ App not trusted for Accessibility. Redirection to System Settings might be required.");
    }
  }

  createWindow();
  registerHotkey();
  createTray();
  startClipboardPolling();

  // Apply theme
  const { settings } = getState();
  nativeTheme.themeSource = settings.theme || "system";
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

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show/Hide", click: () => toggleWindow() },
    { type: "separator" },
    {
      label: "Quit", click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]));
}

