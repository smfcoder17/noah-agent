// Ce que la page de Noah peut demander à l'ordinateur : rien de plus que ces gestes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noahDesktop", {
  pickFolder: () => ipcRenderer.invoke("noah:pick-folder"),
  openPath: (p) => ipcRenderer.invoke("noah:open-path", String(p)),
  lanStatus: () => ipcRenderer.invoke("noah:lan-status"),
  openLan: () => ipcRenderer.invoke("noah:open-lan"),
  version: process.env.npm_package_version || "0.1.0",
});
