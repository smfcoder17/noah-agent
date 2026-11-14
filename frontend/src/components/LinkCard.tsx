import { useContext, useEffect, useState } from "react";
import { send } from "@/lib/api";
import { SensitiveContext, SensitiveText } from "./SensitiveText";
import { sensitiveParts } from "@/lib/sensitive";
import { linkTitle } from "@/lib/linkTitle";
import { t } from "@/i18n";

type Preview = { title: string; site: string; description: string; image: string | null; icon: string | null; duration: number | null };
const cache = new Map<string, Promise<Preview>>();
function read(url: string) { let hit = cache.get(url); if (!hit) { hit = send<Preview>("/api/liens/apercu", { url }); cache.set(url, hit); hit.catch(() => cache.delete(url)); if (cache.size > 256) cache.delete(cache.keys().next().value!); } return hit; }
export function LinkCard({ url, compact = false }: { url: string; compact?: boolean }) {
  const hidden = useContext(SensitiveContext);
  const [data, setData] = useState<Preview | null>(null), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => { let active = true; setError(false); void read(url).then((p) => { if (active) setData(p); }, () => { if (active) setError(true); }); return () => { active = false; }; }, [url, attempt]);
  let host = t("Lien"); try { host = new URL(url).hostname; } catch { return null; }
  const site = data?.site || host;
  const label = data?.title ? linkTitle(data.title, site, host) : host;
  const masked = (s: string) => hidden ? sensitiveParts(s).map((p) => p.masked).join("") : s;
  const duration = data?.duration != null ? ` · ${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, "0")}` : "";
  // Titre et site sur deux lignes ; le séparateur caché les garde distincts pour un lecteur d'écran et un copier-coller.
  return <span className={compact ? "link-row" : "link-card"}><a href={url} target="_blank" rel="noopener noreferrer" aria-label={site !== label ? t("Ouvrir {titre}, {site}", { titre: masked(label), site: masked(site) }) : t("Ouvrir {titre}", { titre: masked(label) })}>
    {!compact && data?.image && <img className="link-thumb" src={data.image} alt="" loading="lazy" />}
    <span className="link-meta">{data?.icon && <img width="16" height="16" src={data.icon} alt="" />}<span className="link-text"><b><SensitiveText text={label} /></b><span className="sr-only"> · </span><small><SensitiveText text={site} />{duration}</small></span></span>
  </a>{error && <button onClick={() => { cache.delete(url); retry(attempt + 1); }}>{t("Aperçu indisponible · Réessayer")}</button>}</span>;
}
export function LinkList({ urls }: { urls: string[] }) { return <span className="link-list">{urls.map((url) => <LinkCard key={url} url={url} compact />)}</span>; }
