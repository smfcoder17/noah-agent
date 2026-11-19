// X9 (0.4.0, L4) : la consigne de mise en forme tient-elle sur de vrais modèles ? Envoie le prompt complet d'un agent (celui de server/noah/main.py : `_soul`)
// et 50 demandes variées à trois modèles de familles différentes (Ollama Cloud), compte par le code les éléments interdits, écrit le résultat.
//   node tools/eval/format-agents.mjs [--modeles deepseek-v4.1-flash,gpt-oss:20b,glm-5.3-flash] [--demandes 50] [--avant]
// Clé : OLLAMA_API_KEY (environnement ou .env du dépôt). Elle n'est ni affichée ni écrite. `--avant` rejoue la même mesure sans la section « Mise en forme ».
// Critère : moins de 2 réponses sur 50 avec un élément interdit, par modèle. Résultat : tools/eval/format-agents-resultats.md et .json ; les réponses
// brutes restent dans le dossier de travail (variable NOAH_REPONSES, sinon rien n'est gardé).
// Interdits comptés (hors blocs ```noah, hors la réaction [[…]] en tête et les lignes MEDIA:) : tableau Markdown, bloc de code (sauf demande de code), JSON dans le texte,
// flèches, symboles décoratifs (émoji, étoiles, filets), adresse nue, liste de plus de six puces.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const MODELES = arg("modeles", "deepseek-v4.1-flash,gpt-oss:20b,glm-5.3-flash").split(",");
const NOMBRE = Number(arg("demandes", "50"));
const AVANT = process.argv.includes("--avant");
const SANS_OUTIL = "Dans cet essai, tu n'as aucun outil : n'en appelle aucun, réponds directement à la demande avec ce que tu sais.";
const KEY = process.env.OLLAMA_API_KEY || [...readFileSync(join(ROOT, ".env"), "utf8").matchAll(/^OLLAMA_API_KEY=(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean).pop();
if (!KEY) {
  console.log("NON VÉRIFIÉ : OLLAMA_API_KEY manque.");
  process.exit(2);
}

// --- Le prompt : celui de l'agent, lu dans le code du serveur -----------------------------------------------------------------------------------------
const source = readFileSync(join(ROOT, "server/noah/main.py"), "utf8");
const capacites = source.match(/^CAPABILITIES = """\\\n([\s\S]*?)"""/m)?.[1];
if (!capacites) throw new Error("CAPABILITIES introuvable dans server/noah/main.py");
const INTRO = "Tu es un agent personnel qui travaille pour l'utilisateur dans Noah Agent. Présente-toi sous ton nom ; ne parle du logiciel ou du modèle qui te fait fonctionner que si on te le demande. "
  + "Tu tutoies toujours la personne, même si d'anciens messages la vouvoient.";
const ROLE = "Assistant personnel polyvalent.";
const soul = (texte) => [INTRO, texte, "## Ton nom\nNoah", `## Ton rôle\n${ROLE}`].join("\n\n");
const SECTION = /## Mise en forme\n[\s\S]*?\n\n(?=## )/;
const AVEC = soul(capacites);
const SANS = soul(capacites.replace(SECTION, ""));

// --- 50 demandes : celles qui poussent un modèle vers un tableau, du code, du JSON, des flèches, des émojis, des adresses et de longues listes ------------
const D = (texte, code = false) => ({ texte, code });
const DEMANDES = [
  D("Compare trois offres de forfait mobile pour moi : Free, Orange et Sfr, sur le prix, les gigas et la durée d'engagement."),
  D("Explique-moi comment faire une pâte à crêpes, étape par étape."),
  D("Fais-moi un compte rendu de ma semaine : j'ai eu deux rendez-vous clients, publié une vidéo, et répondu à une trentaine de courriels."),
  D("Donne-moi un plan de trois jours à Lisbonne avec le matin, l'après-midi et le soir."),
  D("Quels sont les avantages et les inconvénients du télétravail ?"),
  D("Résume-moi les principales différences entre React et Vue."),
  D("Fais la liste des choses à vérifier avant de signer un bail."),
  D("Combien coûte à peu près un abonnement à trois services de streaming populaires ? Donne-moi aussi les liens des sites."),
  D("Je veux comparer deux ordinateurs portables : un MacBook Air et un Dell XPS 13. Qu'est-ce que tu me conseilles ?"),
  D("Peux-tu me donner des idées de noms pour ma chaîne YouTube sur l'intelligence artificielle ?"),
  D("Donne-moi le statut de mes trois projets : site web en retard d'une semaine, newsletter terminée, application mobile à moitié faite."),
  D("Explique la différence entre un SSD et un disque dur, avec des chiffres."),
  D("Quelles sont les étapes pour créer une entreprise individuelle en France ?"),
  D("Fais-moi un budget mensuel simple pour quelqu'un qui gagne 2 400 euros net."),
  D("Quels sont les langages de programmation les plus demandés en ce moment, et pourquoi ?"),
  D("Organise-moi un planning de révision pour un examen dans dix jours, trois matières."),
  D("Explique le processus de décision d'une banque centrale quand elle monte les taux, du début à la fin."),
  D("Donne-moi cinq sources fiables pour apprendre le Python, avec leurs adresses."),
  D("Fais un tableau des fuseaux horaires de New York, Londres, Paris, Tokyo et Sydney."),
  D("Quel est le meilleur moment pour publier sur LinkedIn ? Donne-moi les créneaux jour par jour."),
  D("Récapitule ce qu'il faut préparer pour un déménagement, par échéance."),
  D("Fais-moi une comparaison entre l'achat et la location d'une voiture."),
  D("Je veux une réponse simple : est-ce que je peux congeler du pain ?"),
  D("Peux-tu écrire un courriel pour décaler un rendez-vous de jeudi à vendredi ?"),
  D("Donne-moi les chiffres clés du marché du vélo électrique en France."),
  D("Liste-moi toutes les villes d'Europe de plus de deux millions d'habitants."),
  D("Quelle est la meilleure méthode pour apprendre l'anglais en six mois ?"),
  D("Explique-moi comment fonctionne le chiffrement de bout en bout."),
  D("Fais le point sur les avantages d'un compte pro pour une micro-entreprise : tarifs, plafonds, services."),
  D("Donne-moi un menu de la semaine pour deux personnes, midi et soir."),
  D("Quelle est la différence entre un CDD, un CDI et une mission d'intérim ?"),
  D("Fais-moi la synthèse des étapes d'un lancement de produit : avant, pendant, après."),
  D("Prépare-moi un message de bienvenue pour les nouveaux membres de ma communauté."),
  D("Quels modèles d'IA existent pour générer des images, et lequel choisir pour un logo ?"),
  D("Résume les nouveautés d'iOS en cinq points."),
  D("Dis-moi ce que tu as fait ce matin pour mon projet de newsletter : tu as rédigé trois articles, corrigé les fautes et programmé l'envoi."),
  D("Donne-moi le classement des cinq plus grands pays du monde par superficie."),
  D("Quelle est la marche à suivre si mon colis n'est jamais arrivé ?"),
  D("Peux-tu m'expliquer ce qu'est une API, comme si j'avais dix ans ?"),
  D("Compare les trois plus grands services de stockage en ligne pour un indépendant."),
  D("Donne-moi un exemple de commande pour renommer tous les fichiers .txt en .md dans un dossier sous Linux.", true),
  D("Écris-moi une fonction Python qui dit si un nombre est premier.", true),
  D("Comment je liste les cinq plus gros fichiers d'un dossier avec le terminal ?", true),
  D("Montre-moi une requête SQL qui compte les commandes par client.", true),
  D("Écris un petit script bash qui sauvegarde un dossier dans une archive datée.", true),
  D("Que faire si mon ordinateur ne s'allume plus du tout ? Donne-moi les vérifications dans l'ordre."),
  D("Aide-moi à choisir entre trois idées de vidéo : un test d'outil, une actualité, un tutoriel."),
  D("Fais-moi la liste des documents à fournir pour une demande de visa touristique."),
  D("Qu'est-ce qui a changé dans les règles de la franchise de TVA ? Cite tes sources."),
  D("Récapitule en quelques lignes la différence entre un budget prévisionnel et un budget réel, avec un exemple chiffré."),
].slice(0, NOMBRE);

// --- Ce que le code compte --------------------------------------------------------------------------------------------------------------------------
/** Le texte hors des blocs de code, et les blocs (leur langage). */
function decouper(texte) {
  const hors = [], blocs = [];
  let dedans = null;
  for (const ligne of texte.split("\n")) {
    const f = ligne.match(/^[ \t]*```(.*)$/);
    if (f && dedans === null) { dedans = { langage: f[1].trim() }; blocs.push(dedans); continue; }
    if (f && dedans !== null && f[1].trim() === "") { dedans = null; continue; }
    if (dedans === null) hors.push(ligne);
  }
  return { hors: hors.join("\n"), blocs };
}

function interdits(reponse, code) {
  let texte = String(reponse || "").replace(/^\s*\[\[[^\]\n]{1,16}\]\]\s*/, "");
  texte = texte.replace(/```noah[\s\S]*?(```|$)/g, " ").replace(/^MEDIA:\S+$/gm, " ");
  const { hors, blocs } = decouper(texte);
  const trouves = [];
  if (blocs.length && !code) trouves.push("bloc de code");
  if (blocs.some((b) => /^json$/i.test(b.langage))) trouves.push("json");
  if (/^\s*\|.*\|\s*\n\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/m.test(hors)) trouves.push("tableau");
  if (/\{\s*"[^"\n]+"\s*:/.test(hors)) trouves.push("json");
  if (/→|⇒|➜|➔|➡|⟶|←|<-|->|=>/.test(hors)) trouves.push("flèche");
  if (/\p{Extended_Pictographic}|[★☆✓✔✗✘■□▪▫●○◆◇]|^\s*([-=_*~])\1{3,}\s*$/mu.test(hors)) trouves.push("symbole décoratif");
  const sansLiens = hors.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/<https?:[^>]*>/g, " ");
  if (/https?:\/\/\S+/.test(sansLiens)) trouves.push("adresse nue");
  let suite = 0, longue = false;
  for (const ligne of hors.split("\n")) { // seules les puces de premier niveau comptent ; une sous-puce ou une ligne vide ne coupe pas la liste
    if (/^ {0,1}(?:[-*+•]|\d+[.)])\s+\S/.test(ligne)) suite += 1;
    else if (!/^\s*$/.test(ligne) && !/^ {2,}\S/.test(ligne)) suite = 0;
    if (suite > 6) longue = true;
  }
  if (longue) trouves.push("liste longue");
  return [...new Set(trouves)];
}

async function demander(modele, systeme, demande) {
  let erreur = "";
  for (let essai = 0; essai < 3; essai += 1) {
    try {
      const r = await fetch("https://ollama.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modele, temperature: 0.4, max_tokens: 4000, messages: [{ role: "system", content: systeme + "\n\n" + SANS_OUTIL }, { role: "user", content: demande }] }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.choices?.[0]?.message?.content) throw new Error("réponse vide (" + (data.choices?.[0]?.finish_reason || "?") + ")");
      return { texte: data.choices?.[0]?.message?.content || "", entree: data.usage?.prompt_tokens || 0, sortie: data.usage?.completion_tokens || 0 };
    } catch (e) {
      erreur = String(e.message || e);
      await new Promise((ok) => setTimeout(ok, 2000 * (essai + 1)));
    }
  }
  return { texte: "", entree: 0, sortie: 0, erreur };
}

async function mesurer(modele, systeme) {
  const resultats = new Array(DEMANDES.length);
  let prochain = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = prochain++; i < DEMANDES.length; i = prochain++) {
      const r = await demander(modele, systeme, DEMANDES[i].texte);
      resultats[i] = { ...r, trouves: r.erreur || !r.texte.trim() ? [] : interdits(r.texte, DEMANDES[i].code) };
    }
  }));
  return resultats;
}

const par = {};
const brut = {};
for (const [etat, systeme] of [["apres", AVEC], ...(AVANT ? [["avant", SANS]] : [])]) {
  for (const modele of MODELES) {
    const r = await mesurer(modele, systeme);
    const valides = r.filter((x) => !x.erreur && x.texte.trim());
    const avec = valides.filter((x) => x.trouves.length);
    const parGenre = {};
    for (const x of valides) for (const g of x.trouves) parGenre[g] = (parGenre[g] || 0) + 1;
    par[`${etat}|${modele}`] = { etat, modele, demandes: DEMANDES.length, reponses: valides.length, sans_reponse: r.length - valides.length, avec_element_interdit: avec.length, par_genre: parGenre,
      jetons_entree: r.reduce((n, x) => n + x.entree, 0), jetons_sortie: r.reduce((n, x) => n + x.sortie, 0), erreurs: [...new Set(r.map((x) => x.erreur).filter(Boolean))] };
    brut[`${etat}|${modele}`] = r.map((x, i) => ({ demande: DEMANDES[i].texte, trouves: x.trouves, texte: x.texte }));
    console.log(`${etat} ${modele} : ${avec.length}/${valides.length} avec un élément interdit`, JSON.stringify(parGenre));
  }
}

// Le prix : jetons comptés par l'API. Ollama Cloud est un abonnement, sans prix au jeton : l'estimation prend un tarif large de petit modèle (0,30 $ le million en entrée, 1,20 $ en sortie).
const lignes = Object.values(par);
const entree = lignes.reduce((n, x) => n + x.jetons_entree, 0), sortie = lignes.reduce((n, x) => n + x.jetons_sortie, 0);
const cout = (entree * 0.3 + sortie * 1.2) / 1e6;
const verdict = lignes.filter((x) => x.etat === "apres").every((x) => x.avec_element_interdit < 2 && x.sans_reponse === 0);
const date = new Date().toISOString().slice(0, 10);
const md = [`# Mise en forme des agents : mesure du ${date}`, "",
  `Le prompt complet d'un agent (\`server/noah/main.py\`, \`_soul\`) et ${DEMANDES.length} demandes variées (dont ${DEMANDES.filter((d) => d.code).length} qui demandent du code), envoyés à trois modèles d'Ollama Cloud. `
  + "Le code (`tools/eval/format-agents.mjs`) compte les réponses qui contiennent un élément interdit : tableau Markdown, bloc de code hors demande de code, JSON dans le texte, flèche, symbole décoratif, adresse nue, liste de plus de six puces. Critère : moins de 2 réponses sur 50 par modèle.", "",
  "| Prompt | Modèle | Réponses | Avec un élément interdit | Détail |", "|---|---|---|---|---|",
  ...lignes.map((x) => `| ${x.etat === "apres" ? "avec la consigne" : "sans la consigne"} | ${x.modele} | ${x.reponses}/${x.demandes} | ${x.avec_element_interdit} | ${Object.entries(x.par_genre).map(([g, n]) => `${g} ${n}`).join(", ") || "aucun"} |`), "",
  `Critère (moins de 2 sur 50 avec la consigne, par modèle) : ${verdict ? "atteint" : "NON atteint"}.`, "",
  `Jetons : ${entree} en entrée, ${sortie} en sortie. Coût estimé : ${cout.toFixed(2)} $ (estimation à 0,30 $ et 1,20 $ le million de jetons ; l'abonnement Ollama Cloud ne facture pas au jeton).`, ""].join("\n");
writeFileSync(join(ROOT, "tools/eval/format-agents-resultats.md"), md);
writeFileSync(join(ROOT, "tools/eval/format-agents-resultats.json"), JSON.stringify({ date, modeles: MODELES, resultats: lignes, jetons_entree: entree, jetons_sortie: sortie, cout_estime_usd: +cout.toFixed(3), critere_atteint: verdict }, null, 1));
if (process.env.NOAH_REPONSES) {
  mkdirSync(process.env.NOAH_REPONSES, { recursive: true });
  writeFileSync(join(process.env.NOAH_REPONSES, "reponses.json"), JSON.stringify(brut, null, 1));
}
console.log(`critère ${verdict ? "atteint" : "NON atteint"} ; ${entree} jetons en entrée, ${sortie} en sortie ; coût estimé ${cout.toFixed(2)} $`);
