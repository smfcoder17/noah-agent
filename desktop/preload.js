// Ce que la page de Noah peut demander à l'ordinateur : rien de plus que ces deux gestes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noahDesktop", {
  pickFolder: () => ipcRenderer.invoke("noah:pick-folder"),
  openPath: (p) => ipcRenderer.invoke("noah:open-path", String(p)),
  version: process.env.npm_package_version || "0.1.0",
});
