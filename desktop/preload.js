// Ce que la page de Noah peut demander à l'ordinateur : rien de plus que ces gestes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noahDesktop", {
  pickFolder: () => ipcRenderer.invoke("noah:pick-folder"),
  openPath: (p) => ipcRenderer.invoke("noah:open-path", String(p)),
  lanStatus: () => ipcRenderer.invoke("noah:lan-status"),
  openLan: () => ipcRenderer.invoke("noah:open-lan"),
  forgetServer: () => ipcRenderer.invoke("noah:forget-server"),
  version: () => ipcRenderer.invoke("noah:version"),
});

// Écran du premier lancement seulement (fichier local) : relier l'app à un serveur, ou à Noah sur cet ordinateur.
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("noahSetup", {
    connect: (server, code) => ipcRenderer.invoke("noah:setup-connect", String(server), String(code)),
    authorize: (server) => ipcRenderer.invoke("noah:setup-authorize", String(server)),
    useLocal: () => ipcRenderer.invoke("noah:setup-local"),
    onAskNumber: (fn) => ipcRenderer.on("noah:setup-ask-number", () => fn()),
    sendNumber: (n) => ipcRenderer.invoke("noah:setup-number", String(n)),
    onWaiting: (fn) => ipcRenderer.on("noah:setup-waiting", (_e, verification) => fn(String(verification || ""))),
  });
}
