// @ts-check
/**
 * Electron main process for GMK87 Desktop App
 * Uses CommonJS because package.json has "type": "module"
 * Bridges to ESM API via dynamic import()
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let mainWindow = null;
let api = null;
const logs = [];
const MAX_LOGS = 500;

// Capture console output for the logs viewer
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function captureLog(level, args) {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logs.push({ time: Date.now(), level, msg });
  if (logs.length > MAX_LOGS) logs.shift();
}

console.log = (...args) => { captureLog("info", args); origLog.apply(console, args); };
console.error = (...args) => { captureLog("error", args); origError.apply(console, args); };
console.warn = (...args) => { captureLog("warn", args); origWarn.apply(console, args); };

/**
 * Lazily load the ESM API module
 * @returns {Promise<Object>}
 */
async function getApi() {
  if (!api) {
    api = await import(
      pathToFileURL(path.join(__dirname, "..", "src", "api.js")).href
    );
  }
  return api.default || api;
}

/** Strips the home directory and username from text that may end up in a report */
function cleanForReport(s) {
  const os = require("os");
  const home = os.homedir();
  let user = "";
  try { user = os.userInfo().username; } catch {}
  let out = home ? String(s).split(home).join("~") : String(s);
  if (user && user.length > 2) out = out.split(user).join("<user>");
  return out;
}

// --- Last operation problem (for "Report this problem") ---
// While a keyboard operation runs, the opt-in trace hook in device.js records each
// command's timing. Nothing is sent differently; the hook only observes.
// If the operation throws or any command gets no response, the record is kept so the
// next diagnostics report can include the failure as it actually happened.

let lastIssue = null;
const MAX_ISSUE_COMMANDS = 200;

async function withOperationTrace(operation, fn) {
  const device = await import(
    pathToFileURL(path.join(__dirname, "..", "src", "lib", "device.js")).href
  );
  const hex = (n) => "0x" + n.toString(16).padStart(2, "0");
  const started = Date.now();
  const commands = [];
  const frames = { count: 0, failed: 0, maxMs: 0, firstFailurePos: null };
  const timeouts = new Set();

  device.setProtocolTrace((e) => {
    if (!e.ok) timeouts.add(hex(e.cmd));
    if (e.cmd === 0x21) {
      frames.count++;
      if (e.ok) frames.maxMs = Math.max(frames.maxMs, e.ms);
      else {
        frames.failed++;
        if (frames.firstFailurePos === null) frames.firstFailurePos = e.pos;
      }
      return;
    }
    if (commands.length < MAX_ISSUE_COMMANDS) {
      commands.push({ cmd: hex(e.cmd), pos: e.pos, ms: e.ms, ok: e.ok, discarded: e.discarded });
    }
  });

  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    device.setProtocolTrace(null);
  }

  const noResponse = [...timeouts];
  const problem = error || noResponse.length;
  if (problem) {
    lastIssue = {
      operation,
      at: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      error: error ? cleanForReport(error.message) : null,
      noResponse,
      commands,
      frameData: frames.count ? frames : null,
      logs: logs
        .filter((l) => l.time >= started)
        .slice(-150)
        .map((l) => `${new Date(l.time).toISOString().slice(11, 23)} ${l.level} ${cleanForReport(l.msg)}`),
    };
  }

  if (error) return { success: false, error: error.message, issue: true };
  if (noResponse.length) {
    return { success: true, issue: true, warning: `no response to ${noResponse.join(", ")}` };
  }
  return { success: true };
}

function createWindow() {
  const iconPath = process.platform === "darwin"
    ? path.join(__dirname, "assets", "icon.icns")
    : path.join(__dirname, "assets", "icon.png");

  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0f0f0f",
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  // Remove the menu bar
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

function setupIpcHandlers() {
  ipcMain.handle("keyboard:getInfo", async () => {
    try {
      const gmk87 = await getApi();
      const info = gmk87.getKeyboardInfo();
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:readConfig", async () => {
    try {
      const gmk87 = await getApi();
      const config = await gmk87.readConfig();
      return { success: true, data: config };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:uploadImage", async (_event, { slot0File, slot1File, frameDuration }) => {
    try {
      const gmk87 = await getApi();
      const imagePath = slot0File || slot1File;
      const slot = slot0File ? 0 : 1;
      const options = { slot0File, slot1File };
      if (frameDuration !== undefined) {
        options.frameDuration = frameDuration;
      }
      return await withOperationTrace("Image upload", () => gmk87.uploadImage(imagePath, slot, options));
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:setLighting", async (_event, changes) => {
    try {
      const gmk87 = await getApi();
      return await withOperationTrace("Lighting", () => gmk87.setLighting(changes));
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:applyPreset", async (_event, presetName) => {
    try {
      const gmk87 = await getApi();
      const presetsPath = path.join(__dirname, "..", "presets.json");
      const presetsData = JSON.parse(fs.readFileSync(presetsPath, "utf-8"));
      const preset = presetsData.presets[presetName];
      if (!preset) {
        return { success: false, error: `Preset "${presetName}" not found` };
      }
      return await withOperationTrace(`Lighting preset "${presetName}"`, () => gmk87.setLighting(preset.config));
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:getPresets", async () => {
    try {
      const presetsPath = path.join(__dirname, "..", "presets.json");
      const presetsData = JSON.parse(fs.readFileSync(presetsPath, "utf-8"));
      return { success: true, data: presetsData.presets };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:showSlot", async (_event, slot) => {
    try {
      const gmk87 = await getApi();
      await gmk87.showSlot(slot);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:syncTime", async () => {
    try {
      const gmk87 = await getApi();
      return await withOperationTrace("Time sync", () => gmk87.syncTime());
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("dialog:openFile", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, data: null };
    }
    return { success: true, data: result.filePaths[0] };
  });

  ipcMain.handle("shell:openExternal", async (_event, url) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle("app:getVersion", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version;
  });

  ipcMain.handle("app:getLogs", () => {
    return logs;
  });

  // --- Diagnostics ---

  let diagnosticsRunning = false;

  ipcMain.handle("diagnostics:run", async (event, { mode, tests }) => {
    if (diagnosticsRunning) {
      return { success: false, error: "Diagnostics are already running" };
    }
    diagnosticsRunning = true;
    const logStart = Date.now();
    try {
      const { runDiagnostics } = await import(
        pathToFileURL(path.join(__dirname, "..", "src", "lib", "diagnostics.js")).href
      );
      const appInfo = {
        version: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")).version,
        packaged: app.isPackaged,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
      };
      const report = await runDiagnostics({ mode, tests, app: appInfo }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("diagnostics:progress", progress);
      });

      // Attach backend log lines from this run (home dir / username stripped)
      report.logs = logs
        .filter((l) => l.time >= logStart)
        .slice(-300)
        .map((l) => `${new Date(l.time).toISOString().slice(11, 23)} ${l.level} ${cleanForReport(l.msg)}`);

      // The operation that failed earlier in this session, as it happened
      if (lastIssue) report.failedOperation = lastIssue;

      return { success: true, data: report };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      diagnosticsRunning = false;
    }
  });

  ipcMain.handle("diagnostics:save", async (_event, text) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `gmk87-diagnostics-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { success: true, data: null };
    fs.writeFileSync(result.filePath, text, "utf-8");
    return { success: true, data: result.filePath };
  });

  ipcMain.handle("diagnostics:lastIssue", () => {
    return lastIssue
      ? { operation: lastIssue.operation, at: lastIssue.at, error: lastIssue.error, noResponse: lastIssue.noResponse }
      : null;
  });

  ipcMain.handle("clipboard:writeText", (_event, text) => {
    clipboard.writeText(String(text));
    return { success: true };
  });
}

// --- App Lifecycle ---

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(
      path.join(__dirname, "assets", "icon.png")
    );
    app.dock.setIcon(dockIcon);
  }

  setupIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
