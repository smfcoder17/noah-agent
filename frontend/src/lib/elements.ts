export const ELEMENTS = {
  image: "Image", pdf: "PDF", video: "Vidéo", audio: "Audio", page: "Page", grid: "Grille",
  table: "Tableau", csv: "CSV", document: "Document", presentation: "Présentation", code: "Code", diff: "Différences",
  archive: "Archive", map: "Carte", contact: "Contact", chart: "Graphique", form: "Formulaire", choice: "Choix",
  pr: "Demande de fusion", email: "Courriel", thread: "Fil de courriels", appointment: "Rendez-vous", routine: "Routine",
  watch: "Veille", task: "Tâche", skill: "Compétence", approval: "Accord", batch: "Lot de fichiers", unknown: "Fichier",
} as const;
export type ElementKind = keyof typeof ELEMENTS;
export type ElementSpec = {
  type: "element"; kind: ElementKind; title: string; description?: string; url?: string; path?: string;
  source: "noah" | "moi" | "site"; size?: number; version?: string; data?: Record<string, unknown>;
};
export const elementName = (e: ElementSpec) => `${ELEMENTS[e.kind]} : ${e.title}`;
export const sourceName = (e: ElementSpec) => ({ noah: "Créé par Noah", moi: "Envoyé par moi", site: "Trouvé sur un site" })[e.source];
export function elementUrl(value?: string): string | undefined {
  if (!value || /[\u0000-\u001f\\]/.test(value)) return;
  if (/^\/api\//.test(value)) return value;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return; }
}
export function parseElement(raw: unknown): ElementSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== "element" || typeof e.title !== "string" || !e.title.trim()) return null;
  return { type: "element", kind: typeof e.kind === "string" && Object.prototype.hasOwnProperty.call(ELEMENTS, e.kind) ? e.kind as ElementKind : "unknown",
    title: e.title.slice(0, 300), description: typeof e.description === "string" ? e.description : undefined,
    source: e.source === "moi" || e.source === "site" ? e.source : "noah", size: typeof e.size === "number" && e.size >= 0 ? e.size : undefined,
    version: typeof e.version === "string" ? e.version : undefined, url: elementUrl(typeof e.url === "string" ? e.url : undefined),
    path: typeof e.path === "string" ? e.path : undefined, data: e.data && typeof e.data === "object" && !Array.isArray(e.data) ? e.data as Record<string, unknown> : undefined };
}
