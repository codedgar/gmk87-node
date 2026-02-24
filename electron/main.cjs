// @ts-check
/**
 * Electron main process for GMK87 Desktop App
 * Uses CommonJS because package.json has "type": "module"
 * Bridges to ESM API via dynamic import()
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require("electron");
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

  ipcMain.handle("keyboard:uploadImage", async (_event, { filePath, slot, frameDuration }) => {
    try {
      const gmk87 = await getApi();
      const isGif = path.extname(filePath).toLowerCase() === ".gif";
      const options = {
        slot0File: slot === 0 ? filePath : undefined,
        slot1File: slot === 1 ? filePath : undefined,
      };
      if (isGif && frameDuration) {
        options.frameDuration = frameDuration;
      }
      await gmk87.uploadImage(filePath, slot, options);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("keyboard:setLighting", async (_event, changes) => {
    try {
      const gmk87 = await getApi();
      await gmk87.setLighting(changes);
      return { success: true };
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
      await gmk87.setLighting(preset.config);
      return { success: true };
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
      await gmk87.syncTime();
      return { success: true };
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
