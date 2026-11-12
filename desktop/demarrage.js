// Lancer Noah à l'ouverture de session. Jamais activé tout seul : seul un clic de la personne dans le menu l'active,
// car l'agent retrouve alors l'accès à l'ordinateur sans geste. Aucun champ reçu du serveur n'entre ici.
const DISCRET = "--cache"; // lancé par le système : l'app reste dans la zone de notification, sans fenêtre

function create(app, read, write, { argv = process.argv, platform = process.platform } = {}) {
  // Sous Linux, Electron ne sait pas l'inscrire. Hors installation (développement), on inscrirait electron.exe.
  const available = () => (platform === "win32" || platform === "darwin") && app.isPackaged;
  const options = (on) => (platform === "win32" ? { openAtLogin: on, args: [DISCRET] } : { openAtLogin: on });
  /** Ce que la personne a choisi, et que le système applique encore (elle peut le couper depuis Windows). */
  const get = () => {
    if (read().demarrage_auto !== true || !available()) return false;
    try {
      return app.getLoginItemSettings(platform === "win32" ? { args: [DISCRET] } : undefined).openAtLogin === true;
    } catch {
      return false;
    }
  };
  const set = (on) => {
    if (!available()) return false;
    const wanted = on === true;
    app.setLoginItemSettings(options(wanted));
    write({ demarrage_auto: wanted });
    return get();
  };
  /** Vrai quand c'est le système qui a lancé l'app : pas de fenêtre au premier chargement. */
  const discreet = () => {
    if (read().demarrage_auto !== true) return false; // l'argument seul ne suffit pas : il faut l'avoir choisi
    if (argv.includes(DISCRET)) return true;
    try {
      return platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
      return false;
    }
  };
  return { available, get, set, discreet };
}

module.exports = { create };
