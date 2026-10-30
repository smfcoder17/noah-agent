// Actions de l'agent sur l'ordinateur : l'application récupère chaque demande auprès de Noah, la fait confirmer par
// l'utilisateur dans une boîte de dialogue du système (jamais par la page web), l'exécute et renvoie le résultat.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, clipboard, dialog, Notification, session, shell } = require("electron");

// Un fichier de ces types se lance au lieu de s'ouvrir : seulement par « lancer » ou « commande », confirmés.
const EXECUTABLE = /\.(exe|msi|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|scr|lnk|url|reg|hta|cpl|jar|appref-ms|sh|command|app)$/i;

const prefsFile = () => path.join(app.getPath("userData"), "autorisations.json");
const readPrefs = () => {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
  } catch {
    return {};
  }
};
const savePrefs = (p) => fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 1));

/** Demande l'accord de l'utilisateur. `always` : propose « Ne plus demander pour ce type d'action ». */
async function confirm(kind, message, detail, always) {
  if (always && readPrefs()[kind]) return true;
  const parent = BrowserWindow.getAllWindows().find((w) => w.isVisible());
  const r = await dialog.showMessageBox(parent, {
    type: "question",
    title: "Noah veut agir sur ton ordinateur",
    message,
    detail,
    buttons: ["Autoriser", "Refuser"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    ...(always ? { checkboxLabel: "Ne plus demander pour ce type d'action" } : {}),
  });
  if (r.response !== 0) return false;
  if (always && r.checkboxChecked) savePrefs({ ...readPrefs(), [kind]: true });
  return true;
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, sortie: String(stdout).slice(-6000), erreurs: String(stderr).slice(-3000) });
    });
  });
}

async function perform(req) {
  const who = req.agent || "Noah";
  const refused = { refuse: true, message: "L'utilisateur a refusé cette action." };
  switch (req.action) {
    case "notifier": {
      const n = new Notification({ title: req.titre || who, body: req.texte || "" });
      n.on("click", () => BrowserWindow.getAllWindows()[0]?.show());
      n.show();
      return { ok: true };
    }
    case "presse_papiers":
      clipboard.writeText(req.texte || "");
      return { ok: true };
    case "ouvrir": {
      const target = req.cible;
      if (/^https?:\/\//i.test(target)) {
        if (!(await confirm("ouvrir-page", `${who} veut ouvrir une page dans ton navigateur.`, target, true))) return refused;
        await shell.openExternal(target);
        return { ok: true };
      }
      if (!fs.existsSync(target)) return { erreur: `Introuvable sur l'ordinateur : ${target}` };
      const isDir = fs.statSync(target).isDirectory();
      if (!isDir && EXECUTABLE.test(target)) return { erreur: "Ce fichier est un programme : utilise « lancer » ou « commande »." };
      if (!(await confirm(isDir ? "ouvrir-dossier" : "ouvrir-fichier", `${who} veut ouvrir ${isDir ? "un dossier" : "un fichier"}.`, target, true))) return refused;
      const err = await shell.openPath(target);
      return err ? { erreur: err } : { ok: true };
    }
    case "lancer": {
      const name = req.cible.trim();
      if (!(await confirm("lancer", `${who} veut ouvrir l'application « ${name} ».`, "", false))) return refused;
      if (process.platform === "win32") {
        // Par son exécutable (« notepad », « code ») ou, à défaut, par son nom dans le menu Démarrer (« Calculatrice »).
        const quoted = `'${name.replace(/'/g, "''")}'`;
        const script =
          `$n = ${quoted}; try { Start-Process -FilePath $n -ErrorAction Stop } catch { ` +
          `$a = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1; ` +
          `if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID) } else { throw "Application introuvable : $n" } }`;
        const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
        return r.code === 0 ? { ok: true } : { erreur: r.erreurs || "Application introuvable" };
      }
      const r = process.platform === "darwin" ? await run("open", ["-a", name]) : await run(name, []);
      return r.code === 0 ? { ok: true } : { erreur: r.erreurs || "Application introuvable" };
    }
    case "commande": {
      const cwd = req.dossier && fs.existsSync(req.dossier) ? req.dossier : os.homedir();
      // Jamais de « toujours autoriser » : chaque commande est lue avant d'être lancée.
      if (!(await confirm("commande", `${who} veut exécuter une commande.`, `${req.cible}\n\nDans : ${cwd}`, false))) return refused;
      const r = process.platform === "win32"
        ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", req.cible], cwd)
        : await run("/bin/sh", ["-c", req.cible], cwd);
      return { ok: r.code === 0, ...r, dossier: cwd };
    }
    default:
      return { erreur: `Action inconnue : ${req.action}` };
  }
}

/** Boucle d'écoute : tant que l'application tourne, elle attend les demandes de l'agent. */
function listen(getOrigin) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const origin = getOrigin();
      const cookie = origin && (await session.defaultSession.cookies.get({ url: origin, name: "apollo_session" }))[0];
      if (!cookie) {
        await new Promise((r) => setTimeout(r, 3000)); // pas encore connecté à Noah
        continue;
      }
      const headers = { Authorization: `Bearer ${cookie.value}`, "Content-Type": "application/json" };
      try {
        const r = await fetch(`${origin}/api/desktop/next?os=${process.platform}`, { headers, signal: AbortSignal.timeout(35000) });
        if (r.status !== 200) {
          if (r.status !== 204) await new Promise((res) => setTimeout(res, 3000));
          continue;
        }
        const req = await r.json();
        let result;
        try {
          result = await perform(req);
        } catch (e) {
          result = { erreur: e.message };
        }
        await fetch(`${origin}/api/desktop/result/${req.id}`, { method: "POST", headers, body: JSON.stringify(result) });
      } catch {
        await new Promise((res) => setTimeout(res, 3000)); // Noah redémarre
      }
    }
  };
  loop();
  return () => (stopped = true);
}

module.exports = { listen };
