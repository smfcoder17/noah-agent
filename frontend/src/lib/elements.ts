import { t } from "@/i18n";

export const ELEMENTS = {
  image: t("Image"), pdf: "PDF", video: t("Vidéo"), audio: t("Audio"), page: t("Page"), grid: t("Grille"),
  table: t("Tableau"), csv: "CSV", document: t("Document"), presentation: t("Présentation"), code: t("Code"), diff: t("Différences"),
  archive: t("Archive"), map: t("Carte"), contact: t("Contact"), chart: t("Graphique"), form: t("Formulaire"), choice: t("Choix"),
  pr: t("Demande de fusion"), email: t("Courriel"), thread: t("Fil de courriels"), appointment: t("Rendez-vous"), routine: t("Routine"),
  watch: t("Veille"), task: t("Tâche"), skill: t("Compétence"), approval: t("Accord"), batch: t("Lot de fichiers"), unknown: t("Fichier"),
};
export type ElementKind = keyof typeof ELEMENTS;
export type ElementSpec = {
  agentId?: string;
  type: "element"; kind: ElementKind; title: string; description?: string; url?: string; path?: string;
  source: "noah" | "moi" | "site"; size?: number; version?: string; data?: Record<string, unknown>;
};
export const elementName = (e: ElementSpec) => t("{nom} : {texte}", { nom: ELEMENTS[e.kind], texte: e.title });
export const sourceName = (e: ElementSpec) => ({ noah: t("Créé par Noah"), moi: t("Envoyé par moi"), site: t("Trouvé sur un site") })[e.source];
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

export function kindOfFile(path: string): ElementKind {
  const ext = path.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase() || "";
  const IMAGE = "png jpg jpeg gif webp avif bmp ico svgz".split(" ");
  const VIDEO = "mp4 webm mov m4v mkv avi ogv".split(" ");
  const AUDIO = "mp3 wav ogg oga m4a aac flac opus wma aiff".split(" ");
  const TEXT = ("md markdown mdx txt text log json jsonc json5 yml yaml toml ini cfg conf properties env csv tsv xml " +
    "html htm css scss sass less js jsx mjs cjs ts tsx py pyi ipynb java kt kts scala groovy gradle c h cc cpp cxx hpp " +
    "cs go rs rb php swift m mm pl lua r jl sh bash zsh fish ps1 bat cmd sql graphql gql proto dockerfile makefile " +
    "cmake gitignore editorconfig srt vtt tex rst adoc org nfo readme license").split(" ");
  const TABLE = "xlsx xlsm csv tsv".split(" ");
  const DOCTEXT = "docx docm dotx odt ods odp".split(" ");
  if (IMAGE.includes(ext)) return "image";
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "pptx" || ext === "pptm") return "presentation";
  if (TABLE.includes(ext)) return "table";
  if (DOCTEXT.includes(ext)) return "document";
  if (ext === "diff" || ext === "patch") return "diff";
  if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "tgz" || ext === "bz2" || ext === "xz" || ext === "7z" || ext === "rar") return "archive";
  if (ext === "vcf" || ext === "contact") return "contact";
  if (TEXT.includes(ext)) return "code";
  return "unknown";
}
