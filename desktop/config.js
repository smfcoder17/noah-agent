// Réglages de l'app (config.json) : lus une fois, gardés en mémoire, écrits sans jamais laisser un fichier à moitié écrit.
// Une coupure pendant l'écriture ne fait plus oublier le serveur relié : l'ancien fichier reste, ou sa copie (.bak) prend le relais.
const fs = require("node:fs");
const path = require("node:path");

function create(file) {
  const backup = `${file}.bak`;
  let cache = null;
  let mainValid = false; // le fichier principal a été lu ou écrit entier : lui seul peut devenir la copie de secours
  const parse = (from) => {
    const value = JSON.parse(fs.readFileSync(from, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config illisible");
    return value;
  };
  const load = () => {
    try {
      const value = parse(file);
      mainValid = true;
      return value;
    } catch { /* absent ou tronqué : la copie de secours */ }
    try {
      return parse(backup);
    } catch {
      return {};
    }
  };
  /** Une copie entière (objets imbriqués compris) : modifier ce qu'on reçoit ne change pas les réglages, seul write le fait. */
  const read = () => structuredClone(cache ??= load());
  const write = (patch) => {
    const next = { ...read(), ...patch };
    const text = JSON.stringify(next, null, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      if (mainValid) fs.copyFileSync(file, backup);
      fs.renameSync(temporary, file);
    } catch {
      // Renommage refusé (antivirus, fichier tenu) : écriture directe, la copie de secours couvre une coupure.
      fs.rmSync(temporary, { force: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
    }
    mainValid = true;
    cache = next;
  };
  return { read, write };
}

module.exports = { create };
