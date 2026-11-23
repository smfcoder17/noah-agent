// Utilisation des abonnements, telle que chaque fournisseur la rend pendant les appels que Noah fait de toute façon.
// Un instantané par fournisseur : { offre, modele, mesure_le (ms), tours, fenetres: [{ id, pct, reset (s), etat }] }.
// Rien d'autre n'y entre : ni jeton, ni e-mail, ni texte d'une conversation. Il part au serveur par le battement du pont.
//
// Sources :
//   - Claude Code : l'événement `rate_limit_event` du flux `claude -p --output-format stream-json` (rate_limit_info.unifiedWindows,
//     utilization entre 0 et 1) ;
//   - ChatGPT : les limites que le serveur d'OpenAI joint à la réponse (en-têtes `x-codex-*` ou événement « rate_limits » du flux ;
//     forme { primary|secondary: { used_percent, window_minutes, resets_at } }). La page « Sign in with ChatGPT » d'OpenAI ne
//     documente aucune lecture d'utilisation : si la réponse n'en porte pas, il n'y a pas de fenêtre, seulement les tours comptés ;
//   - Grok : la CLI officielle ne rend que les jetons ; seuls les tours et les jetons sont comptés.
const snapshots = { claude: null, chatgpt: null, grok: null };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const word = (v, max = 40) => (typeof v === "string" && /^[A-Za-z0-9._:-]{1,40}$/.test(v) ? v.slice(0, max) : "");
const round1 = (n) => Math.round(n * 10) / 10;
const clampPct = (n) => Math.max(0, Math.min(100, round1(n)));

/** Une fenêtre Claude : utilization entre 0 et 1 (une valeur déjà en pourcentage, au-delà de 1, passe telle quelle). */
function claudeWindow(id, w) {
  const u = num(w?.utilization);
  const reset = num(w?.resetsAt);
  if (!word(id) || (u === null && !w?.status)) return null;
  return { id: word(id), pct: u === null ? null : clampPct(u <= 1 ? u * 100 : u), reset: reset ? Math.round(reset) : null, etat: stateOf(w?.status) };
}

function stateOf(status) {
  const s = String(status || "").toLowerCase();
  if (s === "allowed") return "permis";
  if (/warning/.test(s)) return "bientot";
  if (/reject|limit|exceed|blocked/.test(s)) return "limite";
  return "permis";
}

/** L'événement `rate_limit_event` de Claude Code → fenêtres (une par type : five_hour, seven_day…). */
function fromClaudeEvent(event) {
  const info = event?.rate_limit_info;
  if (!info || typeof info !== "object") return [];
  const out = [];
  const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
  for (const [id, w] of Object.entries(unified)) {
    const win = claudeWindow(id, w);
    if (win) out.push(win);
  }
  if (!out.length && info.rateLimitType) {
    const win = claudeWindow(info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt, status: info.status });
    if (win) out.push(win);
  }
  return out;
}

/** Le nom d'une fenêtre d'après sa durée : 5 h, 7 jours, 30 jours. */
function windowId(minutes, fallback) {
  const m = num(minutes);
  if (!m) return fallback;
  if (m === 300) return "five_hour";
  if (m === 10080) return "seven_day";
  if (m >= 43000 && m <= 44640) return "thirty_day";
  return `minutes_${Math.round(m)}`;
}

/** Limites au format de l'API d'OpenAI : { primary: { used_percent, window_minutes, resets_at|reset_after_seconds }, secondary: … }. */
function fromCodexLimits(limits, now = Date.now()) {
  if (!limits || typeof limits !== "object") return [];
  const out = [];
  for (const key of ["primary", "secondary"]) {
    const w = limits[key];
    const pct = num(w?.used_percent);
    if (pct === null) continue;
    let reset = num(w?.resets_at);
    if (!reset && num(w?.reset_after_seconds) !== null) reset = Math.round(now / 1000 + num(w.reset_after_seconds));
    out.push({ id: windowId(w?.window_minutes, key === "primary" ? "primary" : "secondary"), pct: clampPct(pct), reset: reset ? Math.round(reset) : null, etat: pct >= 100 ? "limite" : "permis" });
  }
  return out;
}

/** En-têtes d'une réponse (objet Headers ou fonction get) → fenêtres, si OpenAI les a jointes. Rend aussi les NOMS d'en-têtes vus. */
function fromHeaders(headers, now = Date.now()) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : null);
  const limits = {};
  for (const key of ["primary", "secondary"]) {
    const used = get(`x-codex-${key}-used-percent`);
    if (used === null || used === undefined) continue;
    limits[key] = { used_percent: used, window_minutes: get(`x-codex-${key}-window-minutes`), reset_after_seconds: get(`x-codex-${key}-reset-after-seconds`), resets_at: get(`x-codex-${key}-reset-at`) };
  }
  return fromCodexLimits(limits, now);
}

/** Les noms (jamais les valeurs) des en-têtes qui parlent de limites : pour savoir, sur un vrai compte, ce que la route rend. */
function limitHeaderNames(headers) {
  const names = [];
  if (headers && typeof headers.forEach === "function") headers.forEach((_v, k) => { if (/limit|usage|quota|credits|codex|plan/i.test(k)) names.push(String(k).toLowerCase()); });
  return names.sort();
}

function mergeWindows(previous, fresh) {
  const byId = new Map((previous || []).map((w) => [w.id, w]));
  for (const w of fresh) byId.set(w.id, w);
  return [...byId.values()];
}

/** Garde la mesure : les fenêtres rendues remplacent celles du même nom, les autres restent avec leur dernière valeur. */
function record(provider, { fenetres = [], offre, modele, tour = false, jetons = 0, limite = false } = {}, now = Date.now()) {
  if (!(provider in snapshots)) return null;
  const s = snapshots[provider] || { offre: "", modele: "", mesure_le: 0, tours: 0, jetons: 0, fenetres: [] };
  if (fenetres.length) s.fenetres = mergeWindows(s.fenetres, fenetres);
  if (limite) s.fenetres = s.fenetres.length ? s.fenetres.map((w) => ({ ...w, etat: "limite" })) : [{ id: "abonnement", pct: null, reset: null, etat: "limite" }];
  if (typeof offre === "string" && offre) s.offre = word(offre);
  if (typeof modele === "string" && modele) s.modele = String(modele).slice(0, 80);
  if (tour) s.tours += 1;
  if (jetons > 0) s.jetons += Math.round(jetons);
  if (fenetres.length || tour || limite) s.mesure_le = now;
  snapshots[provider] = s;
  return s;
}

/** Les instantanés à envoyer au serveur : seulement ceux qui existent. */
function snapshot() {
  const out = {};
  for (const [k, v] of Object.entries(snapshots)) if (v) out[k] = { ...v, fenetres: v.fenetres.map((w) => ({ ...w })) };
  return out;
}

/** Une phrase par fenêtre pour le menu : « 42 % de ta semaine, remise à zéro jeu. 09:00 ». t : la fonction de textes.js ; lang : « fr » ou « en ». */
const WINDOW_TEXT = { five_hour: "usage.fen.five_hour", seven_day: "usage.fen.seven_day", seven_day_opus: "usage.fen.seven_day_opus", seven_day_sonnet: "usage.fen.seven_day_sonnet",
  thirty_day: "usage.fen.thirty_day", primary: "usage.fen.primary", secondary: "usage.fen.secondary", abonnement: "usage.fen.abonnement" };
const TURNS_TEXT = { grok: ["usage.tours", "usage.tours_un"], autre: ["usage.tours_sans", "usage.tours_sans_un"] };

function describe(provider, snap, t, lang = "fr", now = Date.now()) {
  if (!snap) return [t("usage.aucune", undefined, lang)];
  const label = (w) => {
    const m = /^minutes_(\d+)$/.exec(w.id);
    if (m) return t("usage.fen.minutes", { n: m[1] }, lang);
    const key = WINDOW_TEXT[w.id] || "usage.fen.primary";
    return t(key, undefined, lang);
  };
  const lines = (snap.fenetres || []).map((w) => {
    if (w.etat === "limite" && w.pct === null) return t("usage.limite", undefined, lang);
    if (w.pct === null) return "";
    const pct = Math.round(w.pct);
    const out = w.reset && w.reset * 1000 > now
      ? t("usage.fenetre", { pct, fenetre: label(w), quand: new Date(w.reset * 1000).toLocaleString(lang === "fr" ? "fr-FR" : "en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) }, lang)
      : t("usage.fenetre_sans_date", { pct, fenetre: label(w) }, lang);
    return w.etat === "limite" ? `${out}, ${t("usage.limite", undefined, lang)}` : w.etat === "bientot" ? `${out}, ${t("usage.bientot", undefined, lang)}` : out;
  }).filter(Boolean);
  if (!lines.length && snap.tours) {
    const key = TURNS_TEXT[provider === "grok" ? "grok" : "autre"][snap.tours === 1 ? 1 : 0];
    lines.push(t(key, { n: snap.tours }, lang));
  }
  return lines.length ? lines : [t("usage.aucune", undefined, lang)];
}

const reset = () => { for (const k of Object.keys(snapshots)) snapshots[k] = null; };
const forget = (provider) => { if (provider in snapshots) snapshots[provider] = null; };

module.exports = { describe, fromClaudeEvent, fromCodexLimits, fromHeaders, limitHeaderNames, record, snapshot, reset, forget, windowId };
