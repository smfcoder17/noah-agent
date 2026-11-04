// Banc des tâches vocales : ce que le code vérifie et où il place un échec. Fonctions pures, sans réseau ni navigateur.
//   node tests/real/taches_verif.mjs --autotest    vérifie le vérificateur sur des observations fabriquées, défaut par défaut
//   node tests/real/taches_verif.mjs --valider <fichier>   valide un lot de scénarios, sans en afficher le contenu
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Minuscules, sans accents ni ligatures, tirets et apostrophes changés en espaces. */
export const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-'’_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Le nombre 39 ne se trouve pas dans 1392 : un terme fait de chiffres doit être isolé. */
const hit = (text, term) => {
  const t = norm(term);
  if (/^[\d ]+$/.test(t)) return new RegExp(`(^|[^\\d])${t}([^\\d]|$)`).test(text);
  return text.includes(t);
};
/** `groupes` : tous doivent être présents ; dans un groupe, une des formes suffit. */
export const contains = (text, groupes = []) => {
  const t = norm(text);
  return groupes.filter((g) => !g.some((term) => hit(t, term)));
};

/** Un nombre en toutes lettres : le transcripteur écrit « 17 » quand la phrase dit « dix-sept », ce n'est pas une erreur. */
const UNITS = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix sept", "dix huit", "dix neuf"];
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre vingt", "quatre vingt"];
export function frenchNumber(n) {
  if (n < 20) return UNITS[n];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    if (t === 7 || t === 9) return `${TENS[t]} ${frenchNumber(10 + u)}`;
    if (u === 0) return TENS[t];
    return `${TENS[t]}${u === 1 && t < 8 ? " et un" : ` ${UNITS[u]}`}`;
  }
  if (n < 1000) {
    const c = Math.floor(n / 100), r = n % 100;
    return `${c > 1 ? `${UNITS[c]} ` : ""}cent${r ? ` ${frenchNumber(r)}` : ""}`;
  }
  if (n < 1000000) {
    const m = Math.floor(n / 1000), r = n % 1000;
    return `${m > 1 ? `${frenchNumber(m)} ` : ""}mille${r ? ` ${frenchNumber(r)}` : ""}`;
  }
  return String(n);
}
const words = (text) => norm(text).replace(/\d+/g, (d) => ` ${frenchNumber(Number(d))} `).replace(/\bcents\b/g, "cent").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
export function wordErrorRate(reference, heard) {
  const a = words(reference), b = words(heard);
  if (!a.length) return 0;
  let row = b.map((_, i) => i + 1);
  row.unshift(0);
  a.forEach((x, i) => {
    let prev = row[0];
    row[0] = i + 1;
    b.forEach((y, j) => {
      const cur = row[j + 1];
      row[j + 1] = Math.min(cur + 1, row[j] + 1, prev + (x === y ? 0 : 1));
      prev = cur;
    });
  });
  return row[b.length] / a.length;
}

/** Ce que la personne a vraiment entendu : les réponses dont le son est parti, dans l'ordre. */
// Une réponse coupée par la limite de jetons reste du JSON dans la réponse d'API : seul son « dire » est passé à la synthèse.
const said1 = (p) => (/^\s*\{\s*"dire"/.test(p.texte || "") ? { ...p, texte: (p.texte.match(/"dire"\s*:\s*"((?:[^"\\]|\\.)*)/) || [])[1] || "" } : p);
export const heard = (obs) => (obs.paroles || []).filter((p) => p.joue && (p.texte || "").trim()).map(said1);
export const heardText = (obs) => heard(obs).map((p) => p.texte.trim()).join(" ");
const said = (scn) => scn.plan.filter((s) => s.dire).map((s) => s.dire).join(" ");
const sent = (obs) => (obs.envoyes || []).join(" ");

/** Rend la liste des vérifications : { critere, ok, detail }. Une observation vide échoue partout. */
export function verify(scn, obs) {
  const c = scn.code || {};
  const out = [];
  const add = (critere, ok, detail = "") => out.push({ critere, ok: !!ok, detail: String(detail).slice(0, 300) });
  const text = heardText(obs);
  add("entendu", text.length > 0, text ? "" : "aucune parole entendue");
  if (obs.erreur_banc) add("banc", false, obs.erreur_banc);
  if (c.entendu_contient) {
    const missing = contains(text, c.entendu_contient);
    add("entendu_contient", !missing.length, missing.length ? `manque ${JSON.stringify(missing)}` : "");
  }
  const dels = obs.delegations || [];
  if (c.delegation) {
    const d = dels.find((x) => x.vers === c.delegation.vers);
    add("delegation", !!d, d ? "" : `aucune demande vers ${c.delegation.vers}`);
    if (d && c.delegation.etat) add("delegation_etat", d.etat === c.delegation.etat, `état ${d.etat}`);
    if (d && c.delegation.reponse_contient) {
      const missing = contains(d.reponse, c.delegation.reponse_contient);
      add("delegation_reponse", !missing.length, missing.length ? `manque ${JSON.stringify(missing)}` : "");
    }
  }
  if (c.pas_de_delegation) add("pas_de_delegation", !dels.length, dels.length ? `${dels.length} demande(s) partie(s)` : "");
  const calls = obs.rappels || [];
  if (c.rappel) {
    const ok = calls.some((x) => !contains(x.texte, c.rappel.contient).length);
    add("rappel", ok, ok ? "" : calls.length ? "rappel sans le résultat" : "aucun rappel");
  }
  if (c.pas_de_rappel) add("pas_de_rappel", !calls.length, calls.length ? "rappel inattendu" : "");
  if (c.fichier) {
    const files = (obs.fichiers || []).filter((f) => f.agent === c.fichier.agent);
    const ok = files.some((f) => !contains(f.contenu, c.fichier.contient).length);
    add("fichier", ok, ok ? "" : files.length ? `${files.length} fichier(s), contenu faux` : "aucun fichier nouveau");
  }
  const tools = obs.outil || [];
  if (c.outil) {
    const same = tools.filter((t) => t.nom === c.outil.nom);
    add("outil", same.length > 0, same.length ? "" : `reçu : ${JSON.stringify(tools.map((t) => t.nom))}`);
    if (same.length && c.outil.args_contient) {
      const ok = same.some((t) => !contains(JSON.stringify(t.args), c.outil.args_contient).length);
      add("outil_args", ok, ok ? "" : JSON.stringify(same.map((t) => t.args)));
    }
  }
  for (const name of c.outil_absent || []) add("outil_absent", !tools.some((t) => t.nom === name), `${name} reçu : ${tools.some((t) => t.nom === name)}`);
  if (c.accord_vu) add("accord_vu", !!obs.accord_vu, obs.accord_vu ? "" : "aucune carte d'accord");
  return out;
}

const digitsOf = (text) => String(text ?? "");
export const CAUSES = ["transcription", "tri de la voix rapide", "modèle", "outil", "voix", "banc"];

/**
 * Le premier maillon cassé, dans l'ordre du trajet. `refusParole` : texte que les juges ont refusé, s'il y en a, pour dire
 * qui l'a écrit (voix rapide ou agent). Une seule cause par échec : c'est un classement à relire, pas une preuve.
 */
export function locate(scn, obs, checks, judgedBad = []) {
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length && !judgedBad.length) return null;
  if (obs.erreur_banc) return { cause: "banc", pourquoi: obs.erreur_banc };
  const reference = said(scn);
  const wer = wordErrorRate(reference, sent(obs));
  const garbled = contains(digitsOf(sent(obs)), scn.envoi_contient || []);
  if (!(obs.envoyes || []).length) return { cause: "transcription", pourquoi: "aucun tour n'est parti à l'agent" };
  if (garbled.length) return { cause: "transcription", pourquoi: `« ${sent(obs).slice(0, 120)} » : manque ${JSON.stringify(garbled)}` };
  const terms = failed.filter((c) => c.critere.includes("contient") || c.critere === "outil_args");
  if (wer >= 0.3) return { cause: "transcription", pourquoi: `${Math.round(wer * 100)} % de mots faux : « ${sent(obs).slice(0, 120)} »` };
  const actionChecks = failed.filter((c) => ["delegation", "delegation_etat", "delegation_reponse", "fichier", "outil", "outil_args", "accord_vu", "rappel"].includes(c.critere));
  const triWrong = scn.tri !== null && scn.tri !== undefined && (obs.tri || []).length > 0 && obs.tri[0] !== scn.tri;
  const agentText = (obs.reponses_agent || []).join(" ");
  const written = (obs.reponses_agent || []).length > 0;
  // Le résultat existe par écrit mais n'est jamais arrivé à l'oreille.
  const onlyHeard = failed.length && failed.every((c) => ["entendu", "entendu_contient"].includes(c.critere));
  if ((obs.paroles || []).some((p) => !p.joue && !p.abandonne && (p.texte || "").trim()) && onlyHeard) return { cause: "voix", pourquoi: "une réponse écrite n'a jamais été jouée" };
  if (onlyHeard && scn.code?.entendu_contient && !contains(agentText, scn.code.entendu_contient).length) {
    return { cause: triWrong ? "tri de la voix rapide" : "voix", pourquoi: "le résultat est écrit dans la conversation, il n'a pas été dit" };
  }
  if (onlyHeard && !heardText(obs) && written) return { cause: "voix", pourquoi: "l'agent a répondu par écrit, rien n'a été entendu" };
  if (onlyHeard && triWrong) return { cause: "tri de la voix rapide", pourquoi: `tri ${obs.tri[0]}, attendu ${scn.tri}` };
  if (actionChecks.length) {
    const bad = (obs.delegations || []).some((d) => d.etat === "echec");
    const toolError = (obs.trames_outil || []).some((f) => /error|erreur|échec|refus/i.test(f));
    if (bad || toolError) return { cause: "outil", pourquoi: bad ? "la demande a échoué" : "un outil a répondu une erreur" };
    if (triWrong) return { cause: "tri de la voix rapide", pourquoi: `tri ${obs.tri[0]}, attendu ${scn.tri}` };
    return { cause: "modèle", pourquoi: `${actionChecks.map((c) => `${c.critere} : ${c.detail}`).join(" ; ")}`.slice(0, 200) };
  }
  if (failed.length) {
    if (terms.length && triWrong) return { cause: "tri de la voix rapide", pourquoi: failed[0].detail };
    const quick = heard(obs).every((p) => p.source === "reply");
    return { cause: quick ? "tri de la voix rapide" : "modèle", pourquoi: `${failed[0].critere} : ${failed[0].detail}`.slice(0, 200) };
  }
  // Seuls les juges refusent : celui qui a écrit la phrase citée en répond.
  const cited = judgedBad.map((b) => norm(b.citation)).filter(Boolean);
  const authors = heard(obs).filter((p) => cited.some((c) => norm(p.texte).includes(c)));
  const quick = authors.length ? authors.every((p) => p.source === "reply") : heard(obs).every((p) => p.source === "reply");
  return { cause: quick ? "tri de la voix rapide" : "modèle", pourquoi: `juges : ${judgedBad.map((b) => b.affirmation).join(", ")}` };
}

const FORMS = new Set(["entendu_contient", "delegation", "pas_de_delegation", "rappel", "pas_de_rappel", "fichier", "outil", "outil_absent", "accord_vu"]);
export function validate(scenarios) {
  const errors = [];
  scenarios.forEach((s, i) => {
    const where = `scénario ${i + 1}`;
    if (!s.id || !Array.isArray(s.plan) || !s.plan.length) errors.push(`${where} : id ou plan absent`);
    if (!(s.plan || []).some((p) => typeof p.dire === "string" && p.dire.trim())) errors.push(`${where} : personne ne parle`);
    for (const step of s.plan || []) {
      if (!("dire" in step || "accord" in step || "pause" in step)) errors.push(`${where} : étape inconnue`);
      if ("accord" in step && !["autoriser", "refuser", "attendre"].includes(step.accord)) errors.push(`${where} : accord inconnu`);
    }
    for (const k of Object.keys(s.code || {})) if (!FORMS.has(k)) errors.push(`${where} : vérification inconnue ${k}`);
    if (s.droit_outil && !["lire", "confirmer", "agir"].includes(s.droit_outil)) errors.push(`${where} : droit inconnu`);
    const a = s.agent;
    if (a && !["Noah", "Rita"].includes(a)) errors.push(`${where} : agent inconnu`);
  });
  return errors;
}

function autotest() {
  const scn = {
    id: "x", tri: true, plan: [{ dire: "Demande à Rita de calculer 7 fois 3 et d'écrire le résultat" }],
    code: {
      entendu_contient: [["21", "vingt et un"]], delegation: { vers: "Rita", etat: "fini", reponse_contient: [["21"]] },
      fichier: { agent: "Rita", contient: [["21"]] }, rappel: { contient: [["21"]] },
      outil: { nom: "creer_fiche", args_contient: [["a"]] }, outil_absent: ["echo_jeton"], accord_vu: true,
    },
  };
  const good = {
    paroles: [{ texte: "Rita a trouvé vingt et un.", joue: true, source: "say" }], envoyes: [said(scn)], tri: [true], reponses_agent: ["21"],
    delegations: [{ vers: "Rita", etat: "fini", reponse: "21" }], rappels: [{ texte: "résultat 21" }], fichiers: [{ agent: "Rita", contenu: "21" }],
    outil: [{ nom: "creer_fiche", args: { titre: "a" } }], accord_vu: true,
  };
  const bads = {
    "rien entendu": { paroles: [] },
    "jamais joué": { paroles: [{ texte: "vingt et un", joue: false, source: "say" }] },
    "mauvais nombre": { paroles: [{ texte: "cent vingt et une", joue: true, source: "say" }], rappels: [{ texte: "121" }] },
    "pas de demande": { delegations: [] },
    "demande échouée": { delegations: [{ vers: "Rita", etat: "echec", reponse: "21" }] },
    "pas de rappel": { rappels: [] },
    "fichier faux": { fichiers: [{ agent: "Rita", contenu: "121" }] },
    "fichier d'un autre agent": { fichiers: [{ agent: "Noah", contenu: "21" }] },
    "outil absent": { outil: [] },
    "mauvais arguments": { outil: [{ nom: "creer_fiche", args: { titre: "b" } }] },
    "outil interdit": { outil: [{ nom: "creer_fiche", args: { titre: "a" } }, { nom: "echo_jeton", args: {} }] },
    "pas d'accord": { accord_vu: false },
  };
  let wrong = 0;
  const run = (name, expected, obs) => {
    const fails = verify(scn, obs).filter((c) => !c.ok);
    const ok = expected ? !fails.length : fails.length > 0;
    if (!ok) wrong++;
    console.log(ok ? "OK   " : "ÉCHEC", name, fails.map((f) => f.critere).join(", "));
  };
  run("témoin sans défaut", true, good);
  for (const [name, patch] of Object.entries(bads)) run(name, false, { ...good, ...patch });
  const place = (name, want, obs) => {
    const r = locate(scn, obs, verify(scn, obs).filter((c) => !c.ok));
    if (r?.cause !== want) wrong++;
    console.log(r?.cause === want ? "OK   " : "ÉCHEC", "place :", name, "->", r?.cause);
  };
  place("rien n'est parti", "transcription", { ...good, envoyes: [], delegations: [] });
  place("mots très faux", "transcription", { ...good, envoyes: ["bonjour tout le monde"], delegations: [] });
  place("demande non faite", "modèle", { ...good, delegations: [] });
  place("demande échouée", "outil", { ...good, delegations: [{ vers: "Rita", etat: "echec", reponse: "21" }] });
  place("tri faux, rien fait", "tri de la voix rapide", { ...good, delegations: [], tri: [false] });
  place("résultat écrit, non dit", "voix", { ...good, paroles: [{ texte: "D'accord.", joue: true, source: "reply" }] });
  place("son jamais joué", "voix", { ...good, paroles: [{ texte: "vingt et un", joue: false, source: "say" }] });
  for (const [a, b] of [["dix-sept fois vingt-neuf", "17 fois 29"], ["trente et un fois trois", "31 fois 3"], ["deux mille six cents", "2600"], ["quatre-vingt-treize", "93"]]) {
    const r = wordErrorRate(a, b);
    if (r > 0.1) wrong++;
    console.log(r > 0.1 ? "ÉCHEC" : "OK   ", "nombre :", a, b, r);
  }
  console.log(wrong ? `${wrong} défauts du vérificateur` : "Vérificateur tenu");
  process.exit(wrong ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--autotest")) autotest();
  const i = process.argv.indexOf("--valider");
  if (i > 0) {
    const data = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
    const errors = validate(data.scenarios);
    console.log(errors.length ? errors.join("\n") : `${data.scenarios.length} scénarios valides`);
    process.exit(errors.length ? 1 : 0);
  }
}
