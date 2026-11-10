import { sensitiveParts } from "@/lib/sensitive";
import { SensitiveText } from "../SensitiveText";
import { useContext, useEffect, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { mediaUrl, previewUrl, rawFileUrl, request, send } from "@/lib/api";
import { ELEMENTS, elementName, elementUrl, sourceName, type ElementSpec } from "@/lib/elements";
import { useViewer } from "../Viewer";
import { useMedia } from "./MediaPlayers";

export function ElementCard({ spec }: { spec: ElementSpec }) {
  const view = useViewer();
  const play = useMedia();
  const { agentId } = useContext(AgentContext);
  const [gone, setGone] = useState(false);
  const url = spec.path ? rawFileUrl(agentId, spec.path) : elementUrl(spec.url);
  const [proxied, setProxied] = useState<string | undefined>();
  const [opening, setOpening] = useState(false);
  useEffect(() => { let active = true; if (spec.kind === "image" && url?.startsWith("https://")) void send<{ url: string }>("/api/liens/media", { url }).then((r) => { if (active) setProxied(r.url); }).catch(() => { if (active) setGone(true); }); return () => { active = false; }; }, [url, spec.kind]);
  const data = spec.data && Array.isArray(spec.data.items) ? { ...spec.data, items: spec.data.items.map((it) => { if (!it || typeof it !== "object") return it; const row = it as Record<string, unknown>; return { ...row, image: typeof row.image === "string" && row.image.startsWith("/opt/data/") ? mediaUrl(agentId, row.image) : row.image }; }) } : spec.data;
  const item = { ...spec, data, agentId, url: proxied || url };
  const open = async () => {
    setOpening(true);
    try {
      const shown = spec.kind === "page" && spec.path && /\.html?$/i.test(spec.path) ? { ...item, url: await previewUrl(agentId, spec.path) } : item;
      if (shown.url?.startsWith("/api/") && spec.kind !== "video" && spec.kind !== "audio") { const response = await request(shown.url, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(8000) }); await response.body?.cancel(); }
      if ((spec.kind === "video" || spec.kind === "audio") && shown.url) play({ spec: shown, url: shown.url }); else view({ kind: "element", element: shown });
    } catch { setGone(true); view({ kind: "gone", title: spec.title }); } finally { setOpening(false); }
  };
  return <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); void open(); } }} data-noah-file={url?.startsWith("/api/") ? url : undefined} data-noah-name={spec.title} aria-disabled={opening} className="element-card" aria-label={sensitiveParts(elementName(spec)).map((p) => p.masked).join("")} onClick={() => { if (!opening) void open(); }} onDoubleClick={() => view({ kind: "element", element: item, fullscreen: true })}>
    {spec.kind === "image" && item.url && !gone && (!url?.startsWith("https://") || proxied) ? <img src={item.url} alt={spec.description || spec.title} loading="lazy" onError={() => setGone(true)} /> : <span className="element-kind">{ELEMENTS[spec.kind]}</span>}
    <span className="element-meta"><b><SensitiveText text={spec.title} /></b><small>{sourceName(spec)} · {spec.size != null ? `${(spec.size / 1024).toLocaleString("fr", { maximumFractionDigits: 1 })} Ko` : "Taille non renseignée"}{spec.version && ` · v${spec.version}`}</small>{gone && <small>Fichier introuvable</small>}</span><span aria-hidden>›</span>
  </div>;
}
