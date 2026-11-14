// Ce preload ne s'applique qu'au fichier local du bandeau. Aucun pont vers la page du serveur.
const { ipcRenderer } = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  let shown = null;
  const answer = (response) => {
    if (!shown) return;
    const id = shown.id;
    shown = null;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    ipcRenderer.invoke("noah:accord", id, response).catch(() => {});
  };
  const render = (state) => {
    shown = state;
    document.getElementById("message").textContent = state?.message || "";
    // Donnée affichée telle quelle : ni HTML ni code JavaScript (chemins Windows compris).
    document.getElementById("detail").textContent = state?.detail || "";
    document.getElementById("detail").scrollTop = 0;
    const buttons = document.getElementById("buttons");
    buttons.replaceChildren();
    state?.buttons.forEach((text, index) => {
      const button = document.createElement("button");
      button.className = index === state.refuseIndex ? "secondary" : index === 0 ? "primary" : "discreet";
      button.textContent = text;
      button.addEventListener("click", () => answer(index));
      buttons.append(button);
    });
  };
  // Textes fixes de la page (data-i18n), dans la langue de l'app : la page n'a pas de script, ils viennent du processus principal.
  ipcRenderer.invoke("noah:bandeau-textes").then((page) => {
    if (!page?.textes) return;
    document.documentElement.lang = page.langue;
    for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = page.textes[el.getAttribute("data-i18n")] ?? el.textContent;
    for (const el of document.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", page.textes[el.getAttribute("data-i18n-aria-label")] ?? el.getAttribute("aria-label"));
  }).catch(() => {});
  let updated = false;
  ipcRenderer.on("noah:bandeau", (_event, state) => { updated = true; render(state); });
  ipcRenderer.invoke("noah:bandeau-etat").then((state) => { if (!updated) render(state); }).catch(() => {});
  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.repeat || !shown || !e.ctrlKey || !e.altKey) return;
    if (e.key.toLowerCase() === "a") { e.preventDefault(); answer(0); }
    if (e.key.toLowerCase() === "r") { e.preventDefault(); answer(shown.refuseIndex); }
  });
});
