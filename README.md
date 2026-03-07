# ClipStack 📋

A professional, modern, cross-platform clipboard manager built with Electron, HTML, CSS, and Vanilla JavaScript. ClipStack supercharges your productivity by keeping a smart history of everything you copy, allowing you to instantly search, transform, and paste content seamlessly across any application.

## ✨ Features Included

* **Smart Search:** Instantly search through your entire clipboard history with full-text search.
* **Keyboard Navigation:** Fully navigable via keyboard (`Cmd/Ctrl + Shift + Up/Down`, `Enter` to paste, `S` for snippet, `E` for edit).
* **Universal Auto-Paste:** Pastes directly into your previously focused app automatically. Works flawlessly with text editors (VS Code, Cursor, Antigravity), browsers, and native macOS apps.
* **Snippets Manager:** Save frequently used text (like templates or standard replies) into a dedicated Snippets tab for quick access.
* **Sensitive Data Masking:** Automatically detects and masks sensitive information like passwords, AWS access keys, and bearer tokens in the UI.
* **Text Transformations:** Built-in powerful text formats (Uppercase, Lowercase, Titlecase, Format JSON, Minify JSON, Base64 Encode/Decode, URL Encode/Decode, Remove Duplicates).
* **Rich Media Support:** Native support for both text and image copying, including an image preview popup.
* **Beautiful UI:** Professional Dark and Light themes with glassmorphism effects, dynamic tags, and smooth animations. Matches system preferences automatically.
* **Privacy Controls:** Add specific applications to an Exclusion List so ClipStack won't save any clipboard data when those apps are focused (e.g., password managers).
* **Pro & Team Tiers:** Beautiful subscription locking UI ready to hook up to Stripe (Local dev includes a demo license `CLIPSTACK-PRO-DEMO`).
* **Advanced Analytics:** View usage statistics like most used items, total copies, and breakdowns by content type (Code, Link, Text, Image).
* **Launch at Login:** Automatically start the app in the background when your computer boots up.
* **Export Data:** Export your entire clipboard history as a JSON file for backup.

---

## 💻 How to Run Locally

If you'd like to run ClipStack in development mode and modify the code:

1. **Clone the repository:**
   ```bash
   git clone git@github.com:webozza/ClipStack.git
   cd ClipStack
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```
   *(This uses `nodemon` to automatically reload the app when you edit JS, HTML, or CSS files.)*

---

## 🏗️ How to Build

To create a production-ready application for others to install:

1. Ensure all packages are installed:
   ```bash
   npm install
   ```

2. Run the build command:
   ```bash
   npm run build
   ```
   *(This uses `electron-builder` to package the app. It will output the packaged application to the `dist/` directory.)*

---

## 🚀 How to Install the Build (macOS)

Once you have built the app or downloaded the release, here is how you install it on your Mac:

1. Open the **`dist`** folder in the project directory.
2. Find the generated Apple Disk Image file (e.g., **`Clipboard History-1.0.0-arm64.dmg`**).
3. **Double-click** the `.dmg` file to open it.
4. **Drag and Drop** the **ClipStack** application icon into your Mac's **Applications** folder.
5. Open your Applications folder (or Launchpad) and launch **ClipStack**.
   * *Note: The first time you launch it, you may need to grant Accessibility permissions in macOS `System Settings -> Privacy & Security -> Accessibility` so that the app can monitor global keyboard shortcuts and simulate pasting.*

---

**⌨️ Default Global Hotkey:** `Cmd + Shift + V` (macOS) / `Ctrl + Shift + V` (Windows/Linux)
