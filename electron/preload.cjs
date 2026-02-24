// @ts-check
/**
 * Electron preload script - exposes safe IPC bridge to renderer
 * Uses CommonJS because package.json has "type": "module"
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gmk87", {
  // Keyboard operations
  getInfo: () => ipcRenderer.invoke("keyboard:getInfo"),
  readConfig: () => ipcRenderer.invoke("keyboard:readConfig"),
  uploadImage: (opts) => ipcRenderer.invoke("keyboard:uploadImage", opts),
  setLighting: (changes) => ipcRenderer.invoke("keyboard:setLighting", changes),
  applyPreset: (name) => ipcRenderer.invoke("keyboard:applyPreset", name),
  getPresets: () => ipcRenderer.invoke("keyboard:getPresets"),
  showSlot: (slot) => ipcRenderer.invoke("keyboard:showSlot", slot),
  syncTime: () => ipcRenderer.invoke("keyboard:syncTime"),

  // System
  openFile: () => ipcRenderer.invoke("dialog:openFile"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getLogs: () => ipcRenderer.invoke("app:getLogs"),
});
