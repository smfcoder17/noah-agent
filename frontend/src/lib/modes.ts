// Les modes, en un seul endroit : réglages du cerveau, de la création, de la voix, d'un agent et d'une routine.
export type TierId = "fast" | "balanced" | "smart";
export type ModeId = TierId | "gratuit" | "custom";
export type Level = "cerveau" | "image" | "video" | "music" | "speech" | "transcription";

export const TIERS: { id: TierId; name: string; desc: string; speed: string; descMedia: string }[] = [
  { id: "fast", name: "Rapide", desc: "Trier, résumer, répondre vite.", speed: "Réponses en quelques secondes", descMedia: "Le résultat le plus vite." },
  { id: "balanced", name: "Équilibré", desc: "Le bon choix pour presque tout.", speed: "Navigue, écrit, analyse des fichiers", descMedia: "Une bonne qualité pour un prix raisonnable." },
  { id: "smart", name: "Le plus fort", desc: "Longues recherches, code, décisions délicates.", speed: "Mène des tâches de plusieurs heures", descMedia: "La meilleure qualité, quel qu'en soit le prix." },
];

export const MODE_NAMES: Record<ModeId, string> = { fast: "Rapide", balanced: "Équilibré", smart: "Le plus fort", gratuit: "Gratuit", custom: "Ma liste" };

export const REASONING: { id: string; name: string }[] = [
  { id: "low", name: "Léger, plus rapide et moins cher" },
  { id: "medium", name: "Normal" },
  { id: "high", name: "Poussé, plus lent et plus cher" },
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
};

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

const JOURS: Record<string, string> = { "0": "dimanche", "1": "lundi", "2": "mardi", "3": "mercredi", "4": "jeudi", "5": "vendredi", "6": "samedi", "7": "dimanche" };
const heure = (h: string, m: string) => `${Number(h)} h${Number(m) ? ` ${m.padStart(2, "0")}` : ""}`;
const toutes = (n: number, unite: "minute" | "heure") => (n === 1 ? `Toutes les ${unite}s` : `Toutes les ${n} ${unite}s`);
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
    if (quand === "day") return `Chaque jour à ${h}`;
    if (quand === "weekday") return `Les jours de semaine à ${h}`;
    const jour = { monday: "lundi", tuesday: "mardi", wednesday: "mercredi", thursday: "jeudi", friday: "vendredi", saturday: "samedi", sunday: "dimanche" }[quand];
    return `Chaque ${jour} à ${h}`;
  }
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = parts;
  const whole = /^\d+$/;
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") return toutes(Number(stepMin[1]), "minute");
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (whole.test(min) && stepHour && dom === "*" && mon === "*" && dow === "*") return toutes(Number(stepHour[1]), "heure");
  if (whole.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return Number(min) ? `Chaque heure, à la minute ${Number(min)}` : "Toutes les heures";
  if (!whole.test(min) || !whole.test(hour) || mon !== "*") return raw;
  const h = heure(hour, min);
  if (dom === "*" && dow === "*") return `Chaque jour à ${h}`;
  if (dom === "*" && (dow === "1-5" || dow === "mon-fri")) return `Les jours de semaine à ${h}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0" || dow === "6-7")) return `Le week-end à ${h}`;
  if (dom === "*" && JOURS[dow]) return `Chaque ${JOURS[dow]} à ${h}`;
  if (dow === "*" && whole.test(dom)) return `Le ${dom === "1" ? "1er" : Number(dom)} de chaque mois à ${h}`;
  return raw;
}

const BRANDS: Record<string, string> = {
  deepseek: "DeepSeek", gpt: "GPT", openai: "OpenAI", claude: "Claude", gemini: "Gemini", gemma: "Gemma", llama: "Llama", qwen: "Qwen", glm: "GLM",
  kimi: "Kimi", mistral: "Mistral", grok: "Grok", oss: "OSS", minimax: "MiniMax", sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", nemotron: "Nemotron",
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
  return out.join(" ") + (free ? " (gratuit)" : "");
}

/** Le nom d'un mode d'agent, « auto » compris (le niveau suit chaque demande : server/noah/complexite.py). */
export function modeName(mode: string): string {
  return mode === "auto" ? "Auto" : MODE_NAMES[mode as ModeId] ?? mode;
}
