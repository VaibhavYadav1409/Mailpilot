import { app, BrowserWindow } from "electron";
import path from "node:path";

// Workaround for a known Electron-on-Windows issue: with certain GPU
// drivers (common on integrated/Intel graphics, and after some Windows
// updates), GPU-accelerated compositing can glitch such that a window
// paints as visibly focused — blinking caret, focus ring and all — while
// the compositor silently fails to route real keyboard/IME input to that
// layer. Menu-driven actions like Ctrl+V paste still work because they're
// injected directly rather than routed through the compositor's normal
// input path, which is exactly the "paste works, typing doesn't" pattern
// this app hit. Disabling hardware acceleration forces software
// compositing instead, which sidesteps the bug entirely. This must run
// before app.whenReady().
app.disableHardwareAcceleration();

// The backend's Gmail OAuth callback (backend/src/routes/gmail.ts) finishes
// by redirecting the browser to `${EMPLOYEE_APP_URL}/?synced=1` (or
// ?error=...). That works when EMPLOYEE_APP_URL points at a real running
// web server (e.g. the Vite dev server during `pnpm dev`), but the
// packaged desktop app has no such server — there's nothing at that URL to
// load, so the window would get stuck on a failed/blank navigation.
//
// Fix: set EMPLOYEE_APP_URL on the backend to this sentinel value (it's
// never actually fetched over the network — see the will-redirect
// interception below), and reload the local packaged index.html instead,
// carrying over the same query string so the existing
// `new URLSearchParams(window.location.search)` logic in Home.tsx keeps
// working unmodified.
const OAUTH_REDIRECT_SENTINEL = "https://mailpilot-desktop.local";

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    autoHideMenuBar: true,
    // Start hidden and only show once the page has actually painted (see
    // `ready-to-show` below). Showing a BrowserWindow immediately on
    // creation can render a frame — including a blinking text caret in an
    // autofocused input — before Windows has actually handed the window
    // OS-level keyboard focus. That matches the reported symptom exactly:
    // a visible cursor that never receives keystrokes until the window is
    // manually refocused (Alt-Tab away/back, or a relaunch). Deferring
    // show()+focus() until the renderer is ready avoids that race.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // win.focus() only focuses the OS-level window. It does NOT guarantee the
  // Chromium renderer (webContents) inside it has keyboard focus — those are
  // two separate focus states in Electron. That gap is exactly what
  // explains the reported bug: Ctrl+V paste kept working (Electron's default
  // Edit menu executes paste via IPC, independent of renderer focus) while
  // normal typing did nothing (real keystrokes only reach the renderer if
  // webContents itself is focused). Focusing both closes that gap.
  const focusWindow = () => {
    win.focus();
    win.webContents.focus();
  };

  win.once("ready-to-show", () => {
    win.show();
    focusWindow();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const indexPath = path.join(__dirname, "../dist/index.html");

  const interceptOAuthRedirect = (url: string) => {
    if (!url.startsWith(OAUTH_REDIRECT_SENTINEL)) return false;
    const search = new URL(url).search; // e.g. "?synced=1" or "?error=gmail_auth_failed"
    win.loadFile(indexPath, { search });
    return true;
  };

  win.webContents.on("will-redirect", (event, url) => {
    if (interceptOAuthRedirect(url)) event.preventDefault();
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (interceptOAuthRedirect(url)) event.preventDefault();
  });

  // Any in-place navigation (the OAuth-redirect reload above, a manual
  // refresh, etc.) re-paints the window but doesn't re-fire
  // `ready-to-show`, and can leave OS focus pointed at whatever had it
  // before the reload started. Re-assert focus after every load so typing
  // works immediately, not just on first launch.
  win.webContents.on("did-finish-load", () => {
    if (win.isVisible()) focusWindow();
  });

  // When the OS hands keyboard focus back to this window (e.g. Alt-Tab, or
  // clicking the taskbar icon), explicitly pull the renderer's focus along
  // with it — otherwise the window can look focused while the page
  // underneath still isn't.
  win.on("focus", () => {
    win.webContents.focus();
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools();
  } else {
    win.loadFile(indexPath);
  }

  return win;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});