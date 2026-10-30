
// =================================================================
// NOAH : un onglet ouvert à la main garde les cookies de l'agent
// =================================================================
// Chaque session de l'agent est un conteneur Firefox. Ctrl+T, le bouton + et les liens ouverts en nouvel onglet
// ouvraient hors de ce conteneur : l'utilisateur s'y connectait à un site, l'agent restait déconnecté. On donne à
// chaque nouvel onglet le conteneur de l'onglet affiché.
try {
  Services.obs.addObserver((win) => {
    try {
      const open = win.openTrustedLinkIn;
      if (typeof open !== "function" || open.__noah) return;
      const wrapped = function (url, where, params) {
        params = params || {};
        if ((where === "tab" || where === "tabshifted" || where === "window") && params.userContextId == null) {
          const id = Number(win.gBrowser?.selectedBrowser?.getAttribute("usercontextid") || 0);
          if (id) params = Object.assign({}, params, { userContextId: id });
        }
        return open.call(this, url, where, params);
      };
      wrapped.__noah = true;
      win.openTrustedLinkIn = wrapped;
    } catch (e) {}
  }, "browser-delayed-startup-finished");
} catch (e) {}
