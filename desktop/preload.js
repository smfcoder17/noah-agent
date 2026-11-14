// Ce que la page de Noah peut demander à l'ordinateur : rien de plus que ces gestes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noahDesktop", {
  pickFolder: () => ipcRenderer.invoke("noah:pick-folder"),
  openPath: (p) => ipcRenderer.invoke("noah:open-path", String(p)),
  fileMenu: (url, name) => ipcRenderer.invoke("noah:file-menu", String(url), String(name)),
  forgetServer: () => ipcRenderer.invoke("noah:forget-server"),
  dossiers: () => ipcRenderer.invoke("noah:dossiers"),
  dossierAjouter: () => ipcRenderer.invoke("noah:dossier-ajouter"),
  dossierRetirer: (id) => ipcRenderer.invoke("noah:dossier-retirer", String(id)),
  dossierDroit: (id, ecriture) => ipcRenderer.invoke("noah:dossier-droit", String(id), Boolean(ecriture)),
  couper: (coupe) => ipcRenderer.invoke("noah:couper", Boolean(coupe)),
  dossierOuvrir: (id) => ipcRenderer.invoke("noah:dossier-ouvrir", String(id)),
  commandeOublier: (commande, dossier) => ipcRenderer.invoke("noah:commande-oublier", String(commande), String(dossier)),
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
    langue: () => ipcRenderer.invoke("noah:langue"),
  });
}
