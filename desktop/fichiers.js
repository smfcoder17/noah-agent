// Clic droit sur un fichier de l'agent dans la fenêtre de Noah : le menu du système. Le fichier vient du serveur (session de la
// fenêtre), arrive dans Téléchargements/Noah sans rien écraser, marqué « venu d'Internet ». Un programme ou un script ne s'ouvre pas
// d'ici : seulement « Afficher dans le dossier ». Node pur pour l'essentiel, testable sans Electron.
const fs = require("node:fs");
const path = require("node:path");

// Ce qui s'ouvre d'un clic : documents et médias, comme « ouvrir » dans actions.js.
const OPENABLE = /\.(pdf|txt|md|rtf|csv|tsv|log|json|xml|yaml|yml|html?|png|jpe?g|gif|webp|bmp|svg|heic|tiff?|mp3|wav|m4a|flac|ogg|mp4|mov|mkv|webm|avi|docx?|xlsx?|pptx?|odt|ods|odp|epub|ics|zip)$/i;
const MAX_FILE = 200 * 1024 * 1024;

/** Un nom sans chemin, ni caractère interdit, ni nom réservé de Windows. */
function safeName(name) {
  const base = String(name || "fichier").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*‪-‮⁦-⁩]/g, "_").replace(/^\.+/, "").trim().slice(0, 150);
  return !base || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base) ? "fichier" : base;
}

/** Écrit sans écraser : « nom (2).ext » si le nom est pris. */
function freePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      fs.closeSync(fs.openSync(candidate, "wx"));
      return candidate;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error("Trop de fichiers portent ce nom.");
}

function markFromInternet(file, platform = process.platform) {
  if (platform !== "win32") return;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch {
    /* disque sans flux alternatifs */
  }
}

/** Télécharge `url` (même origine que Noah, vérifiée par l'appelant) dans `dir`. `fetcher` : la session de la fenêtre. */
async function download(fetcher, url, name, dir) {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`Le serveur a répondu ${r.status}.`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > MAX_FILE) throw new Error("Fichier trop gros.");
  fs.mkdirSync(dir, { recursive: true });
  const target = freePath(dir, safeName(name));
  fs.writeFileSync(target, data);
  markFromInternet(target);
  return target;
}

/** Les entrées du menu, selon le type : l'ouverture d'un clic n'existe que pour un document ou un média. */
function entries(name, platform = process.platform) {
  const openable = OPENABLE.test(safeName(name));
  return [
    openable && { id: "ouvrir", label: "Ouvrir" },
    openable && platform === "win32" && { id: "ouvrir-avec", label: "Ouvrir avec…" },
    { id: "dossier", label: platform === "darwin" ? "Afficher dans le Finder" : "Afficher dans le dossier" },
  ].filter(Boolean);
}

module.exports = { OPENABLE, download, entries, freePath, safeName };
