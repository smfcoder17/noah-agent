// Les blocs ```noah écrits par l'agent, vérifiés avant l'affichage : un bloc mal formé retombe en texte, jamais en écran cassé.
import { t } from "@/i18n";

export type PostTone = "ok" | "info" | "muted" | "warn";
export type PostItem = { platform: string; account?: string; text?: string; image?: string; more: number; url?: string; state?: { label: string; tone: PostTone }; date?: string; note?: string };
export type ProductItem = { title: string; price?: string; merchant?: string; image?: string; url?: string; rating?: string; note?: string; badge?: string };
export type LinkItem = { title: string; url: string; site: string; note?: string };
export type Normalized =
  | { type: "posts"; title?: string; note?: string; items: PostItem[] }
  | { type: "products"; title?: string; note?: string; items: ProductItem[] }
  | { type: "links"; title?: string; note?: string; items: LinkItem[] };

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
/** Un texte affichable : chaîne ou nombre, sinon rien. */
export const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
/** Seules les adresses web s'ouvrent : jamais javascript:, data: ni un chemin local. */
export const webUrl = (v: unknown): string | undefined => { const s = text(v); return s && /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined; };
const image = (v: unknown): string | undefined => { const s = text(v); return s && (/^https?:\/\//i.test(s) || s.startsWith("/opt/data/")) ? s : undefined; };
const itemsOf = (spec: Raw, single: (spec: Raw) => boolean): Raw[] => Array.isArray(spec.items) ? spec.items.filter(isObject) : single(spec) ? [spec] : [];

// i18n-ignore : noms des réseaux, écrits pareil dans toutes les langues
const PLATFORMS: Record<string, string> = { x: "X", twitter: "X", instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", tiktok: "TikTok", youtube: "YouTube", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", pinterest: "Pinterest" };
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
export function platformName(v: unknown, url?: string): string {
  const given = text(v);
  if (given) return PLATFORMS[fold(given)] ?? given;
  try { const host = new URL(url ?? "").hostname.replace(/^www\./, ""); const parts = host.split("."); return PLATFORMS[parts[parts.length - 2] ?? ""] ?? host; } catch { return t("Post"); }
}
export function postState(v: unknown): PostItem["state"] {
  const given = text(v);
  if (!given) return undefined;
  const s = fold(given);
  if (/^(publie|en ligne|published|posted|live)/.test(s)) return { label: t("Publié"), tone: "ok" };
  if (/^(prevu|programme|planifie|scheduled)/.test(s)) return { label: t("Prévu"), tone: "info" };
  if (/^(brouillon|draft|a publier|a valider)/.test(s)) return { label: t("Brouillon"), tone: "muted" };
  if (/^(echec|echoue|erreur|rate|refuse|failed|error)/.test(s)) return { label: t("Échec"), tone: "warn" };
  return { label: given, tone: "muted" };
}

/** Posts, produits et liens : null si rien d'affichable, et le bloc retombe en texte. */
export function normalizeBlock(spec: unknown): Normalized | null {
  if (!isObject(spec)) return null;
  const title = text(spec.title), note = text(spec.note);
  const type = fold(String(spec.type ?? ""));
  if (type === "posts" || type === "post") {
    const items = itemsOf(spec, (s) => !!(text(s.text) || webUrl(s.url))).map((it): PostItem => {
      const url = webUrl(it.url);
      const images = [it.image, ...(Array.isArray(it.images) ? it.images : [])].map(image).filter((s): s is string => !!s);
      return { platform: platformName(it.platform, url), account: text(it.account), text: text(it.text), image: images[0], more: Math.max(0, images.length - 1), url, state: postState(it.state), date: text(it.date), note: text(it.note) };
    }).filter((it) => it.text || it.url || it.image);
    return items.length ? { type: "posts", title: type === "post" && !Array.isArray(spec.items) ? undefined : title, note, items } : null;
  }
  if (type === "products" || type === "product" || type === "produits") {
    const items = itemsOf(spec, (s) => !!text(s.title)).map((it): ProductItem | null => {
      const name = text(it.title) ?? text(it.name);
      return name ? { title: name, price: text(it.price), merchant: text(it.merchant) ?? text(it.store), image: image(it.image) ?? (Array.isArray(it.images) ? image(it.images[0]) : undefined), url: webUrl(it.url), rating: text(it.rating), note: text(it.note), badge: text(it.badge) } : null;
    }).filter((it): it is ProductItem => !!it);
    return items.length ? { type: "products", title: type === "products" || Array.isArray(spec.items) ? title : undefined, note, items } : null;
  }
  if (type === "links" || type === "sources" || type === "liens") {
    const items = itemsOf(spec, () => false).map((it): LinkItem | null => {
      const url = webUrl(it.url);
      if (!url) return null;
      const site = new URL(url).hostname.replace(/^www\./, "");
      return { title: text(it.title) ?? site, url, site: text(it.site) ?? site, note: text(it.note) };
    }).filter((it): it is LinkItem => !!it);
    return items.length ? { type: "links", title, note, items } : null;
  }
  return null;
}

/** Les blocs déjà connus : vrai si leurs champs indispensables ont la bonne forme. */
export function wellFormed(spec: Raw): boolean {
  const list = (v: unknown) => Array.isArray(v);
  switch (spec.type) {
    case "choice": return list(spec.options) && (spec.options as unknown[]).length > 0 && (spec.options as unknown[]).every((o) => typeof o === "string" || typeof o === "number");
    case "grid": return list(spec.items) && (spec.items as unknown[]).every(isObject);
    case "table": return list(spec.columns) && list(spec.rows) && (spec.rows as unknown[]).every(list);
    case "chart": return list(spec.labels) && list(spec.series) && (spec.series as unknown[]).every((s) => isObject(s) && list(s.values));
    case "preview": return typeof spec.path === "string" && !!spec.path;
    case "video": return typeof spec.url === "string" && !!spec.url;
    default: return true;
  }
}
