// Les modes, en un seul endroit : réglages du cerveau, de la création, de la voix, d'un agent et d'une routine.
import { t } from "@/i18n";

export type TierId = "fast" | "balanced" | "smart";
export type ModeId = TierId | "gratuit" | "custom";
export type Level = "cerveau" | "image" | "video" | "music" | "speech" | "transcription";

export const TIERS: { id: TierId; name: string; desc: string; speed: string; descMedia: string }[] = [
  { id: "fast", name: t("Rapide"), desc: t("Trier, résumer, répondre vite."), speed: t("Réponses en quelques secondes"), descMedia: t("Le résultat le plus vite.") },
  { id: "balanced", name: t("Équilibré"), desc: t("Le bon choix pour presque tout."), speed: t("Navigue, écrit, analyse des fichiers"), descMedia: t("Une bonne qualité pour un prix raisonnable.") },
  { id: "smart", name: t("Le plus fort"), desc: t("Longues recherches, code, décisions délicates."), speed: t("Mène des tâches de plusieurs heures"), descMedia: t("La meilleure qualité, quel qu'en soit le prix.") },
];

export const MODE_NAMES: Record<ModeId, string> = { fast: t("Rapide"), balanced: t("Équilibré"), smart: t("Le plus fort"), gratuit: t("Gratuit"), custom: t("Ma liste") };

export const REASONING: { id: string; name: string }[] = [
  { id: "low", name: t("Léger, plus rapide et moins cher") },
  { id: "medium", name: t("Normal") },
  { id: "high", name: t("Poussé, plus lent et plus cher") },
];

export type ModeLink = {
  modele: string;
  fournisseur: string;
  nom: string;
  price_in: number | null;
  price_out: number | null;
  free: boolean;
  prix?: string | null;
  inconnu?: boolean;
};

export type ModesState = {
  niveau: Level;
  actif: ModeId | "auto" | null;
  en_service: string;
  modes: { id: TierId; personnalise: boolean; modele: ModeLink | null }[];
  gratuit: ModeLink[];
  custom: ModeLink[];
  /** Cerveau seulement : les agents qui gardent leur propre modèle ou mode, que le cerveau de tous ne touche pas. */
  agents_propres?: OwnBrain[];
};

export type OwnBrain = { id: string; nom: string; modele: string | null; mode: string | null; fournisseur: string | null; fournisseur_nom: string | null };

export type ListedModel = {
  id: string;
  name: string;
  lab: string;
  created: number;
  context: number;
  price_in: number | null;
  price_out: number | null;
  vision: boolean;
  free: boolean;
  fournisseur: string;
  prix?: string | null;
};

const JOURS: Record<string, string> = { "0": t("dimanche"), "1": t("lundi"), "2": t("mardi"), "3": t("mercredi"), "4": t("jeudi"), "5": t("vendredi"), "6": t("samedi"), "7": t("dimanche") };
const heure = (h: string, m: string) => (Number(m) ? t("{h} h {m}", { h: Number(h), m: m.padStart(2, "0") }) : t("{h} h", { h: Number(h) }));
const toutes = (n: number, unite: "minute" | "heure") => unite === "minute"
  ? (n === 1 ? t("Toutes les minutes") : t("Toutes les {n} minutes", { n }))
  : (n === 1 ? t("Toutes les heures") : t("Toutes les {n} heures", { n }));
const AMPM = (h: string, ap?: string) => (ap?.toLowerCase() === "pm" && Number(h) < 12 ? String(Number(h) + 12) : ap?.toLowerCase() === "am" && h === "12" ? "0" : h);

/** Un horaire en français : le brut seulement si la forme n'est pas courante. */
export function scheduleLabel(raw: string): string {
  const s = raw.trim().replace(/^cron\s+/i, "");
  const every = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?)$/i.exec(s);
  if (every) {
    const n = Number(every[1]);
    if (every[2][0].toLowerCase() === "h") return toutes(n, "heure");
    return n % 60 === 0 ? toutes(n / 60, "heure") : toutes(n, "minute");
  }
  const human = /^every\s+(day|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (human) {
    const h = heure(AMPM(human[2], human[4]), human[3] ?? "0");
    const quand = human[1].toLowerCase();
    if (quand === "day") return t("Chaque jour à {heure}", { heure: h });
    if (quand === "weekday") return t("Les jours de semaine à {heure}", { heure: h });
    const jour = { monday: JOURS["1"], tuesday: JOURS["2"], wednesday: JOURS["3"], thursday: JOURS["4"], friday: JOURS["5"], saturday: JOURS["6"], sunday: JOURS["0"] }[quand] ?? quand;
    return t("Chaque {jour} à {heure}", { jour, heure: h });
  }
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = parts;
  const whole = /^\d+$/;
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") return toutes(Number(stepMin[1]), "minute");
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (whole.test(min) && stepHour && dom === "*" && mon === "*" && dow === "*") return toutes(Number(stepHour[1]), "heure");
  if (whole.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return Number(min) ? t("Chaque heure, à la minute {n}", { n: Number(min) }) : t("Toutes les heures");
  if (!whole.test(min) || !whole.test(hour) || mon !== "*") return raw;
  const h = heure(hour, min);
  if (dom === "*" && dow === "*") return t("Chaque jour à {heure}", { heure: h });
  if (dom === "*" && (dow === "1-5" || dow === "mon-fri")) return t("Les jours de semaine à {heure}", { heure: h });
  if (dom === "*" && (dow === "0,6" || dow === "6,0" || dow === "6-7")) return t("Le week-end à {heure}", { heure: h });
  if (dom === "*" && JOURS[dow]) return t("Chaque {jour} à {heure}", { jour: JOURS[dow], heure: h });
  if (dow === "*" && whole.test(dom)) return dom === "1" ? t("Le 1er de chaque mois à {heure}", { heure: h }) : t("Le {jour} de chaque mois à {heure}", { jour: Number(dom), heure: h });
  return raw;
}

// Noms de marques : les mêmes dans toutes les langues.
const BRANDS: Record<string, string> = {
  deepseek: "DeepSeek", gpt: "GPT", openai: "OpenAI", claude: "Claude", gemini: "Gemini", gemma: "Gemma", llama: "Llama", qwen: "Qwen", glm: "GLM", // i18n-ignore : marque
  kimi: "Kimi", mistral: "Mistral", grok: "Grok", oss: "OSS", minimax: "MiniMax", sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", nemotron: "Nemotron", // i18n-ignore : marque
};

/** Un identifiant de modèle (« fournisseur/nom-version-date ») dit comme un nom ; un nom déjà lisible reste tel quel. */
export function readableModel(id: string | null | undefined): string {
  const raw = (id ?? "").trim();
  if (!raw || /\s/.test(raw) || !/[/:_-]/.test(raw)) return raw;
  const free = /:free$/i.test(raw);
  const words = (raw.split("/").pop() ?? raw).replace(/:.*$/, "").split(/[-_]/).filter((w) => w && !/^\d{4,}$/.test(w));
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (/^\d$/.test(w) && prev && /\d$/.test(prev)) out[out.length - 1] = prev + "." + w; // « 5-1 » se lit « 5.1 »
    else out.push(BRANDS[w.toLowerCase()] ?? (/^v?\d/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  }
  return free ? t("{nom} (gratuit)", { nom: out.join(" ") }) : out.join(" ");
}

/** Le nom d'un mode d'agent, « auto » compris (le niveau suit chaque demande : server/noah/complexite.py). */
export function modeName(mode: string): string {
  return mode === "auto" ? t("Auto") : MODE_NAMES[mode as ModeId] ?? mode;
}
