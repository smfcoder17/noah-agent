import { useState } from "react";
import { elementName, elementUrl, sourceName, type ElementSpec } from "@/lib/elements";
import { SandboxedFrame } from "./SandboxedFrame";
import { useDownload } from "../Viewer";

export function ElementViewer({ spec }: { spec: ElementSpec }) {
  const url = elementUrl(spec.url);
  const download = useDownload();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const data = spec.data ?? {};
  const rows = Array.isArray(data.rows) ? data.rows as unknown[][] : [];
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return <div className="element-viewer">
    <p className="element-origin">{sourceName(spec)}{spec.version && ` · version ${spec.version}`} · {spec.size == null ? "Taille non renseignée" : `${spec.size} octets`}</p>
    {spec.description && <p>{spec.description}</p>}
    {error ? <p role="alert">Fichier introuvable. <button onClick={() => setError(false)}>Réessayer</button></p>
      : spec.kind === "image" && url ? <div className="image-stage"><img src={url} alt={spec.description || spec.title} onError={() => setError(true)} style={{ transform: `scale(${zoom})` }} /><label>Zoom <input type="range" min="1" max="4" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label></div>
      : ["page", "pdf", "code", "csv"].includes(spec.kind) && url ? <SandboxedFrame title={elementName(spec)} src={url} className="element-frame" onError={() => setError(true)} />
      : spec.kind === "grid" || spec.kind === "batch" ? <div className="element-grid">{items.map((it, i) => <article key={i}>{elementUrl(String(it.image ?? "")) && <img src={elementUrl(String(it.image))} alt={String(it.title ?? "")} />}<b>{String(it.title ?? "")}</b><p>{String(it.subtitle ?? "")}</p></article>)}</div>
      : spec.kind === "table" || spec.kind === "chart" ? <div className="overflow-auto"><table><thead><tr>{columns.map((c, i) => <th key={i}>{String(c)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>)}</tbody></table></div>
      : <div className="element-detail">{Object.entries(data).map(([key, value]) => <p key={key}><b>{key} : </b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</p>)}{!Object.keys(data).length && <p>Aperçu indisponible.</p>}</div>}
    {url && <button className="element-download" onClick={() => download(url, spec.title)}>Télécharger</button>}
  </div>;
}
