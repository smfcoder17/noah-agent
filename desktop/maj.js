// Mise à jour de l'app de bureau elle-même (main.js, bandeau, actions sur l'ordinateur). L'interface, elle, vient du serveur et
// se met à jour seule. Vérifie au démarrage puis toutes les 6 h, télécharge en arrière-plan (electron-updater, versions
// publiées sur GitHub), puis propose de redémarrer pour installer. Sans accord, la mise à jour s'installe à la fermeture de l'app.
// Toute erreur (GitHub injoignable, disque plein) va au journal seulement : l'app ne s'en aperçoit pas.
const SIX_HEURES = 6 * 60 * 60 * 1000;

const numeros = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(String(v ?? "").trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null;
};
const plusRecente = (a, b) => { // vrai si a > b
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i];
  return false;
};

/** Faut-il proposer cette version ? Une vraie version (pas une préversion -rc), plus récente que celle qui tourne, et pas déjà proposée. */
function aProposer(disponible, courante, dejaProposee = "") {
  const v = numeros(disponible), c = numeros(courante);
  if (!v || v.pre) return false;
  if (c && !plusRecente(v, c)) return false;
  return String(disponible) !== String(dejaProposee);
}

/**
 * @param {object} o
 * @param {object} o.updater   autoUpdater d'electron-updater (ou sa doublure en test)
 * @param {string} o.version   version de l'app qui tourne
 * @param {(cle: string, vars?: object) => string} o.t   textes de l'app
 * @param {(options: object) => Promise<{response: number}>} o.ask   boîte de dialogue (non bloquante pour la fenêtre)
 * @param {(msg: string) => void} o.log   journal
 * @param {(fn: Function, ms: number) => any} [o.every]   setInterval, remplaçable en test
 */
function create({ updater, version, t, ask, log, every = setInterval }) {
  let downloaded = "";   // version téléchargée, prête à installer
  let proposed = "";     // version déjà proposée pendant cette exécution : une seule fois, pas toutes les 6 h
  let started = false;
  const refresh = [];    // appelés quand une mise à jour devient prête (le menu s'en sert)

  async function propose(v) {
    if (proposed === v) return;
    proposed = v;
    try {
      const r = await ask({
        type: "info", title: "Noah Agent", noLink: true,
        message: t("maj.prete", { version: v }),
        buttons: [t("maj.redemarrer"), t("maj.plus_tard")], defaultId: 0, cancelId: 1,
      });
      if (r?.response === 0) install();
    } catch (e) { log(`proposition : ${e?.message || e}`); }
  }

  /** Redémarre l'app et installe ce qui est téléchargé. Sans mise à jour prête, ne fait rien. */
  function install() {
    if (!downloaded) return false;
    try {
      updater.quitAndInstall(false, true);
      return true;
    } catch (e) { log(`installation : ${e?.message || e}`); return false; }
  }

  async function check() {
    try {
      await updater.checkForUpdates();
    } catch (e) { log(`vérification : ${e?.message || e}`); }
  }

  /** Branche electron-updater et lance la vérification (maintenant, puis toutes les 6 h). */
  function start() {
    if (started) return;
    started = true;
    updater.autoDownload = true;           // télécharge sans rien demander : seul le redémarrage demande un accord
    updater.autoInstallOnAppQuit = true;   // « Plus tard » : installée à la prochaine fermeture de l'app
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;       // vX.Y.Z-rc1 ignorée, même si l'app qui tourne est une préversion
    updater.allowDowngrade = false;
    updater.logger = { info: (m) => log(String(m)), warn: (m) => log(`attention : ${m}`), error: (m) => log(`erreur : ${m}`), debug() {} };
    updater.on("error", (e) => log(`erreur : ${e?.message || e}`));
    updater.on("update-available", (info) => log(`version ${info?.version} trouvée, téléchargement`));
    updater.on("update-downloaded", (info) => {
      const v = info?.version;
      // Même contrôle qu'à la vérification : jamais de préversion ni de version qui ne dépasse pas celle qui tourne.
      if (!aProposer(v, version)) return log(`version ${v} ignorée`);
      downloaded = v;
      for (const f of refresh) f(v);
      propose(v);
    });
    check();
    const timer = every(check, SIX_HEURES);
    timer?.unref?.();
  }

  return { start, check, install, ready: () => downloaded, onReady: (f) => refresh.push(f) };
}

module.exports = { create, aProposer, SIX_HEURES };
