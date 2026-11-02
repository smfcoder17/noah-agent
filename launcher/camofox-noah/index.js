// Plugin Noah pour Camofox : l'écran partagé et l'agent utilisent les mêmes cookies.
//
// Chaque session Camofox (celle de l'agent) est un « conteneur » Firefox. Sans réglage, un onglet que
// l'utilisateur ouvre à la main dans l'écran (Ctrl+T, bouton +, nouvelle fenêtre) s'ouvre hors de ce conteneur :
// il s'y connecte à un site, mais l'agent, lui, reste déconnecté. Ces préférences gardent tout nouvel onglet dans
// le conteneur de l'onglet courant, et ouvrent les nouvelles fenêtres en onglets.
//
// Après un redémarrage du navigateur, Camofox répond 410 pour un ancien onglet. L'outil navigateur d'Hermes ne
// recrée son onglet que sur un 404 : il restait bloqué, et l'agent contournait par des commandes curl, bien plus
// lentes. Pour « navigate », le 410 devient un 404 (Hermes ouvre alors un nouvel onglet à la bonne adresse).
//
// Prise en main par l'utilisateur (connexion, code 2FA, CAPTCHA) : aucune capture d'écran n'est faite tant qu'elle
// dure, ni par l'agent ni par personne (G7.7, comme le mode « takeover » de ChatGPT agent). Noah Agent l'ouvre et la
// ferme par POST /noah/prive?secondes=N, avec une clé à part (NOAH_PRIVATE_KEY) : l'agent a la clé d'API du
// navigateur, pas celle-ci, il ne peut donc pas couper la protection. L'échéance est gardée sur le disque : un
// redémarrage du navigateur pendant la prise en main ne rouvre pas les captures.
import fs from "node:fs";

const STATE = "/data/noah-prive.json";
let privateUntil = 0;
try {
  privateUntil = Number(JSON.parse(fs.readFileSync(STATE, "utf8")).jusqua) || 0;
} catch {}

export default function register(app, ctx) {
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/noah/prive") {
      if (!process.env.NOAH_PRIVATE_KEY || req.headers.authorization !== `Bearer ${process.env.NOAH_PRIVATE_KEY}`) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const seconds = Math.max(0, Math.min(Number(req.query.secondes) || 0, 3 * 3600));
      privateUntil = seconds ? Date.now() + seconds * 1000 : 0;
      try {
        fs.writeFileSync(STATE, JSON.stringify({ jusqua: privateUntil }));
      } catch (e) {
        ctx.log("warn", `noah: mode privé non enregistré (${e.message})`);
      }
      return res.json({ prive: seconds > 0 });
    }
    if (Date.now() < privateUntil && (/\/screenshot$/.test(req.path) || req.query.includeScreenshot === "true")) {
      return res.status(423).json({ error: "L'utilisateur a la main sur l'écran : aucune capture pendant ce temps." });
    }
    if (req.method === "POST" && /^\/tabs\/[^/]+\/navigate$/.test(req.path)) {
      const status = res.status.bind(res);
      res.status = (code) => status(code === 410 ? 404 : code);
    }
    next();
  });
  // Les extensions sont chargées après les routes de Camofox : on place celle-ci en tête pour qu'elle passe avant.
  const stack = app.router?.stack || app._router?.stack;
  if (stack) stack.unshift(stack.pop());

  ctx.events.on("browser:launching", ({ options }) => {
    options.firefoxUserPrefs = {
      ...(options.firefoxUserPrefs || {}),
      "privacy.userContext.enabled": true,
      "privacy.userContext.newTabContainerOnLeftClick.enabled": true,
      "browser.link.open_newwindow": 3,
      "browser.link.open_newwindow.restriction": 0,
      // Pas de pages gardées en mémoire pour le bouton Précédent : les consoles (Google Cloud…) pèsent des centaines de Mo.
      "browser.sessionhistory.max_total_viewers": 0,
    };
    ctx.log("info", "noah: nouveaux onglets gardés dans le conteneur de l'agent");
  });
}
