import { useEffect, useState } from "react";
import { send } from "@/lib/api";
import { SensitiveText } from "./SensitiveText";

type Preview = { title: string; site: string; description: string; image: string | null; icon: string | null; duration: number | null };
const cache = new Map<string, Promise<Preview>>();
function read(url: string) { let hit = cache.get(url); if (!hit) { hit = send<Preview>("/api/liens/apercu", { url }); cache.set(url, hit); hit.catch(() => cache.delete(url)); if (cache.size > 256) cache.delete(cache.keys().next().value!); } return hit; }
export function LinkCard({ url, compact = false }: { url: string; compact?: boolean }) {
  const [data, setData] = useState<Preview | null>(null), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => { let active = true; setError(false); void read(url).then((p) => { if (active) setData(p); }, () => { if (active) setError(true); }); return () => { active = false; }; }, [url, attempt]);
  let host = "Lien"; try { host = new URL(url).hostname; } catch { return null; }
  return <span className={compact ? "link-row" : "link-card"}><a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir ${data?.title || host}`}>
    {!compact && data?.image && <img className="link-thumb" src={data.image} alt="" loading="lazy" />}
    <span className="link-meta">{data?.icon && <img width="16" height="16" src={data.icon} alt="" />}<b><SensitiveText text={data?.title || host} /></b><small>{data?.site || host}{data?.duration != null && ` · ${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, "0")}`}</small></span>
  </a>{error && <button onClick={() => { cache.delete(url); retry(attempt + 1); }}>Aperçu indisponible · Réessayer</button>}</span>;
}
export function LinkList({ urls }: { urls: string[] }) { return <span className="link-list">{urls.map((url) => <LinkCard key={url} url={url} compact />)}</span>; }
