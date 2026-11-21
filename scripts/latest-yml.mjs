#!/usr/bin/env node
// latest.yml : le fichier que l'app de bureau (electron-updater) lit sur GitHub pour savoir qu'une version existe, où la
// télécharger et quelle empreinte elle doit avoir. Il doit citer exactement le fichier joint au Release, avec son empreinte
// sha512 (base64) et sa taille : sinon l'app refuse la mise à jour, ou pire, cherche un fichier qui n'existe pas.
//
//   node scripts/latest-yml.mjs ecrire   <latest.yml> <installateur.exe> <version>   réécrit latest.yml depuis le fichier
//   node scripts/latest-yml.mjs verifier <latest.yml> <installateur.exe> <version>   refuse (code 1) tout désaccord
//
// « ecrire » garde la date de publication d'origine, cite le nom du fichier tel qu'il est joint (noah-agent-windows-setup.exe)
// et recalcule empreinte et taille depuis ce fichier, puis le relit : c'est la garantie que le Release dit vrai.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Lit les champs de latest.yml dont on a besoin (le format d'electron-builder est plat et fixe). */
export function lire(texte) {
  const champ = (nom) => {
    const m = new RegExp(`^${nom}:\\s*(.+?)\\s*$`, "m").exec(texte);
    return m ? m[1].replace(/^['"]|['"]$/g, "") : "";
  };
  const fichier = (nom) => {
    const m = new RegExp(`^\\s+(?:- )?${nom}:\\s*(.+?)\\s*$`, "m").exec(texte); // dans files:
    return m ? m[1].replace(/^['"]|['"]$/g, "") : "";
  };
  return { version: champ("version"), path: champ("path"), sha512: champ("sha512"), releaseDate: champ("releaseDate"), url: fichier("url"), size: fichier("size") };
}

export function empreinte(fichier) {
  return createHash("sha512").update(readFileSync(fichier)).digest("base64");
}

/** Le contenu de latest.yml pour ce fichier, dans la forme exacte qu'écrit electron-builder. */
export function produire({ nom, sha512, size, version, releaseDate }) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${nom}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${nom}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

/** Les désaccords entre latest.yml et le fichier joint ; liste vide si tout concorde. */
export function ecarts(texte, exe, version) {
  const l = lire(texte), nom = basename(exe), problemes = [];
  if (l.version !== version) problemes.push(`version : latest.yml dit « ${l.version} », attendu « ${version} »`);
  if (l.path !== nom) problemes.push(`path : latest.yml dit « ${l.path} », le fichier joint s'appelle « ${nom} »`);
  if (l.url !== nom) problemes.push(`files[0].url : latest.yml dit « ${l.url} », le fichier joint s'appelle « ${nom} »`);
  const sha = empreinte(exe);
  if (l.sha512 !== sha) problemes.push("sha512 : ne correspond pas au fichier joint");
  if (Number(l.size) !== statSync(exe).size) problemes.push(`size : latest.yml dit ${l.size}, le fichier fait ${statSync(exe).size} octets`);
  return problemes;
}

function main([mode, yml, exe, version]) {
  if (!["ecrire", "verifier"].includes(mode) || !yml || !exe || !version) {
    console.error("usage : latest-yml.mjs ecrire|verifier <latest.yml> <installateur.exe> <version>");
    return 2;
  }
  if (!existsSync(exe)) return console.error(`Introuvable : ${exe}`), 1;
  if (mode === "ecrire") {
    const date = existsSync(yml) ? lire(readFileSync(yml, "utf8")).releaseDate : "";
    writeFileSync(yml, produire({
      nom: basename(exe), sha512: empreinte(exe), size: statSync(exe).size, version,
      releaseDate: date || new Date().toISOString(),
    }));
  }
  if (!existsSync(yml)) return console.error(`Introuvable : ${yml}`), 1;
  const problemes = ecarts(readFileSync(yml, "utf8"), exe, version);
  if (problemes.length) {
    console.error(`latest.yml incohérent :\n  ${problemes.join("\n  ")}`);
    return 1;
  }
  console.log(`latest.yml : ${basename(exe)}, version ${version}, sha512 et taille concordent.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
