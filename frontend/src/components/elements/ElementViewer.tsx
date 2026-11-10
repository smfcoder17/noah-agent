import { send } from "@/lib/api";
import { appShell, elementAction } from "@/lib/platform";
import { SensitiveContext, SensitiveText } from "../SensitiveText";
import { useContext } from "react";
import { sensitiveParts } from "@/lib/sensitive";
import { Dialog, DialogContent } from "../ui";
﻿import { useRef, useState } from "react";
import { elementName, elementUrl, sourceName, type ElementSpec } from "@/lib/elements";
import { askAgent } from "@/lib/askAgent";
import { SandboxedFrame } from "./SandboxedFrame";
import { useDownload } from "../Viewer";
import { Chart } from "../Widgets";

const ACTIONS: Partial<Record<ElementSpec["kind"], string>> = { pr: "Voir l'analyse", email: "Relire le brouillon", thread: "Relire le fil", appointment: "Dans la discussion", routine: "Modifier la routine", watch: "Modifier la veille", task: "Voir le résultat", skill: "Dans la discussion", approval: "Ouvrir la demande" };
export function ElementViewer({ spec, onClose }: { spec: ElementSpec; onClose?: () => void }) {
  const hidden = useContext(SensitiveContext);
  const display = (text: string) => hidden ? sensitiveParts(text).map((p) => p.masked).join("") : text;
  const [pending, setPending] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const url = elementUrl(spec.url);
  const download = useDownload();
  const [actionError, setActionError] = useState("");
  const [error, setError] = useState(false), [zoom, setZoom] = useState(1), [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState((spec.size ?? 0) <= 10_000_000);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; zoom: number; y: number } | null>(null);
  const data = spec.data ?? {};
  const [enabled, setEnabled] = useState(Boolean(data.active ?? data.enabled));
  const [fields, setFields] = useState<Record<string, string>>({});
  const toggle = async () => { if (!spec.agentId || typeof data.id !== "string") return; try { await send(`/api/agents/${encodeURIComponent(spec.agentId)}/${spec.kind === "routine" ? "routines" : "watches"}/${encodeURIComponent(data.id)}/${enabled ? "pause" : "reprendre"}`, {}); setEnabled(!enabled); setActionError(""); } catch (e) { setActionError((e as Error).message); } };
  const rows = Array.isArray(data.rows) ? data.rows.filter(Array.isArray) as unknown[][] : [];
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const items = Array.isArray(data.items) ? data.items.filter((v) => v && typeof v === "object") as Record<string, unknown>[] : [];
  const deliver = (text: string) => { askAgent(text, spec.agentId); onClose?.(); };
  const ask = (text: string) => {
    if (hidden && sensitiveParts(text).some((p) => p.sensitive)) {
      setPending(text); setRevealed(false);
    } else deliver(text);
  };
  return <div className="element-viewer">
    <p className="element-origin">{sourceName(spec)}{spec.version && ` · version ${spec.version}`} · {spec.size == null ? "Taille non renseignée" : `${spec.size.toLocaleString("fr")} octets`}</p>
    {spec.description && <p><SensitiveText text={spec.description} /></p>}
    {error ? <p role="alert">Fichier introuvable. <button onClick={() => setError(false)}>Réessayer</button></p>
      : !loaded ? <div><p>Fichier volumineux. <SensitiveText text={spec.description || "Aperçu sur demande."} /></p><button onClick={() => setLoaded(true)}>Charger l'aperçu</button></div>
      : spec.kind === "image" && url ? <div className="image-stage" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); points.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); const p = [...points.current.values()]; gesture.current = { distance: p.length === 2 ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0, zoom, y: e.clientY }; }}
        onPointerMove={(e) => { if (!points.current.has(e.pointerId)) return; points.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); const p = [...points.current.values()], g = gesture.current; if (p.length === 2 && g?.distance) setZoom(Math.max(1, Math.min(4, g.zoom * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.distance))); }}
        onPointerUp={(e) => { if (points.current.size === 1 && zoom === 1 && gesture.current && e.clientY - gesture.current.y > 120) onClose?.(); points.current.delete(e.pointerId); }} onPointerCancel={(e) => points.current.delete(e.pointerId)}>
        <img src={url} alt={display(spec.description || spec.title)} onError={() => setError(true)} style={{ transform: `scale(${zoom})` }} /><label>Zoom <input type="range" min="1" max="4" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label></div>
      : spec.kind === "pdf" && url ? <><div className="flex gap-3 items-center"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Page précédente</button><span>Page {page}{Number(data.pages) > 0 ? ` / ${Number(data.pages)}` : ""}</span><button disabled={Number(data.pages) > 0 && page >= Number(data.pages)} onClick={() => setPage(page + 1)}>Page suivante</button><label>Zoom <input type="range" min=".5" max="3" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label></div><SandboxedFrame title={elementName(spec)} src={url.split("#")[0] + `#page=${page}&zoom=${zoom * 100}`} className="element-frame" onError={() => setError(true)} /></>
      : spec.kind === "page" && url ? <SandboxedFrame title={elementName(spec)} src={url} className="element-frame" onError={() => setError(true)} />
      : spec.kind === "grid" || spec.kind === "batch" ? <div className="element-grid">{items.map((it, i) => <article key={i}>{elementUrl(String(it.image ?? "")) && <img src={elementUrl(String(it.image))} alt={String(it.title ?? "")} loading="lazy" />}<b><SensitiveText text={String(it.title ?? "")} /></b><p><SensitiveText text={String(it.subtitle ?? "")} /></p></article>)}</div>
      : spec.kind === "chart" && Array.isArray(data.series) && Array.isArray(data.labels) ? <Chart spec={data as unknown as React.ComponentProps<typeof Chart>["spec"]} />
      : ["table", "csv", "chart"].includes(spec.kind) && rows.length ? <div className="overflow-auto"><table><thead><tr>{columns.map((c, i) => <th key={i}>{String(c)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}><SensitiveText text={String(cell)} /></td>)}</tr>)}</tbody></table></div>
      : ["code", "diff"].includes(spec.kind) && typeof data.text === "string" ? <pre className="overflow-auto"><code><SensitiveText text={data.text} /></code></pre>
      : spec.kind === "archive" ? <ul>{!items.length && <li>Liste indisponible. Télécharge le fichier pour le lire.</li>}{items.map((it, i) => <li key={i}>{String(it.name || it.title || "Fichier")} {it.size != null && `· ${String(it.size)} octets`}</li>)}</ul>
      : spec.kind === "form" && Array.isArray(data.fields) ? <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); ask(`Formulaire « ${spec.title} » : ${JSON.stringify(fields)}`); }}>{data.fields.filter((f): f is string => typeof f === "string").map((f) => <label key={f}>{f}<input className="shell-search block w-full" value={fields[f] ?? ""} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} /></label>)}<button className="shell-primary">Envoyer mes réponses</button></form>
      : (spec.kind === "form" || spec.kind === "choice") && Array.isArray(data.options) ? <div className="element-actions">{data.options.map((o, i) => <button key={i} onClick={() => ask(String(o))}>{display(String(o))}</button>)}</div>
      : <div className="element-detail">{Object.entries(data).map(([key, value]) => <p key={key}><b>{key} : </b><SensitiveText text={typeof value === "object" ? JSON.stringify(value) : String(value)} /></p>)}{!Object.keys(data).length && <p>Aperçu indisponible.</p>}</div>}
    {(spec.kind === "routine" || spec.kind === "watch") && typeof data.id === "string" && spec.agentId && <label className="shell-row">Active<input role="switch" type="checkbox" checked={enabled} onChange={() => void toggle()} /></label>}
    {actionError && <p role="alert">{actionError}</p>}
    <div className="element-actions">{url && appShell() && <button onClick={() => void elementAction("openWith", url, spec.title).catch((e) => setActionError(e.message))}>Ouvrir avec</button>}{url && appShell()?.kind === "android" && <button onClick={() => void elementAction("share", url, spec.title).catch((e) => setActionError(e.message))}>Partager</button>}{ACTIONS[spec.kind] && <button onClick={() => ask(`${ACTIONS[spec.kind]} : ${spec.title}\n${JSON.stringify(data)}`)}>{ACTIONS[spec.kind]}</button>}{url && <button onClick={() => download(url, spec.title)}>Télécharger</button>}</div>
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
      {pending !== null && <DialogContent title="Relire avant d'envoyer">
        <p>Révèle les données pour vérifier ce que tu envoies à l'agent.</p>
        <SensitiveContext.Provider value={!revealed}><pre className="whitespace-pre-wrap"><SensitiveText text={pending} /></pre></SensitiveContext.Provider>
        <button onClick={() => setRevealed(!revealed)}>{revealed ? "Recacher" : "Révéler avant d'envoyer"}</button>
        <button disabled={!revealed} onClick={() => { const text = pending; setPending(null); deliver(text); }}>Envoyer à l'agent</button>
      </DialogContent>}
    </Dialog>
  </div>;
}
