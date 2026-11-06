// Tourne dans le conteneur du navigateur : des pages d'envoi qui lisent vraiment le fichier reçu et affichent son empreinte.
import { createServer } from "node:http";

const SCRIPT = `
async function vu(input) {
  const lignes = [];
  for (const f of input.files) {
    const hash = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    lignes.push(f.name + " " + f.size + " " + hex);
  }
  const p = document.createElement("p");
  p.textContent = "RECU " + input.id + " : " + lignes.join(" ; ");
  document.body.append(p);
}
document.addEventListener("change", (e) => { if (e.target.type === "file") vu(e.target); });
`;
const PAGES = {
  "/un": `<h1>Un champ</h1><input type="file" id="seul">`,
  "/fenetre": `<h1>Profil et fenêtre</h1><input type="file" id="profil"><div role="dialog" aria-label="Créer"><input type="file" id="post" multiple></div>`,
  "/deux": `<h1>Deux champs</h1><input type="file" id="premier" name="a"><input type="file" id="second" name="b">`,
  "/bouton": `<h1>Bouton</h1><button id="b" onclick="document.getElementById('cache').click()">Choisir un fichier</button><input type="file" id="cache" style="display:none">`,
  "/panneau": `<h1>Panneau</h1><button id="b" onclick="setTimeout(()=>{const i=document.createElement('input');i.type='file';i.id='monte';document.body.append(i)},500)">Ouvrir</button>`,
  "/inerte": `<h1>Inerte</h1><button id="b">Ne fait rien</button><input type="file" id="profil">`,
  "/cachee": `<h1>Cachée</h1><div role="dialog" style="display:none"><input type="file" id="ferme"></div><iframe style="display:none" srcdoc="<div role='dialog'><input type='file' id='cadre'></div>"></iframe><input type="file" id="principal">`,
  "/dialogue": `<h1>Dialogue</h1><button id="b" onclick="document.getElementById('d').style.display='block'">Ouvrir</button><input type="file" id="profil"><div role="dialog" id="d" style="display:none"><input type="file" id="ouverte"></div>`,
  "/aucun": `<h1>Aucun champ</h1><p>Rien à joindre ici.</p>`,
};
createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>Envoi</title>${PAGES[req.url] || "introuvable"}<script>${SCRIPT}</script>`);
}).listen(9999, "127.0.0.1");
