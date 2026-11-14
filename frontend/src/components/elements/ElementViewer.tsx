import { send } from "@/lib/api";
import { appShell, elementAction } from "@/lib/platform";
import { SensitiveContext, SensitiveText } from "../SensitiveText";
import { sensitiveParts } from "@/lib/sensitive";
import { Dialog, DialogContent } from "../ui";
import { SENSITIVE_MARKDOWN } from "../SensitiveMarkdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useContext, useEffect, useRef, useState } from "react";
import { elementName, elementUrl, sourceName, type ElementSpec } from "@/lib/elements";
import { askAgent } from "@/lib/askAgent";
import { SandboxedFrame } from "./SandboxedFrame";
import { useDownload } from "../Viewer";
import { Chart } from "../Widgets";
import { locale, t } from "@/i18n";

const ACTIONS: Partial<Record<ElementSpec["kind"], string>> = { pr: t("Voir l'analyse"), email: t("Relire le brouillon"), thread: t("Relire le fil"), appointment: t("Dans la discussion"), routine: t("Modifier la routine"), watch: t("Modifier la veille"), task: t("Voir le résultat"), skill: t("Dans la discussion"), approval: t("Ouvrir la demande") };
/** Un fichier texte ou Markdown (.md, .txt, .log…) : son contenu se lit ici, sans passer par le téléchargement. */
/** Un fichier dont le contenu se lit comme du texte : code, données, notes, tout ce qui n'est pas binaire. La liste est
 * large à dessein — un .java, un .ps1, un .srt ou un .conf se lisent aussi. Le serveur transe le type ; ici on ne fait que
 * proposer la lecture. */
const TEXT_EXT = /\.(md|markdown|mdx|txt|text|log|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|env|csv|tsv|xml|html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|pyi|ipynb|java|kt|kts|scala|groovy|gradle|c|h|cc|cpp|cxx|hpp|cs|go|rs|rb|php|swift|m|mm|pl|lua|r|jl|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|proto|dockerfile|makefile|cmake|gitignore|editorconfig|diff|patch|srt|vtt|tex|rst|adoc|org|nfo|readme|license)$/i;
/** Un fichier bureautique : son texte est extrait par le serveur. */
const OFFICE_EXT = /\.(docx|docm|dotx|pptx|pptm|xlsx|xlsm|odt|ods|odp)$/i;

/** Le contenu vient d'un fichier de l'agent, pas du chat : les liens externes partent dans l'onglet, les autres restent du texte. */
const TEXT_MARKDOWN: NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]> = {
  a: ({ children, href, ...props }) => /^https?:/i.test(href || "") ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ children }) => <span>{children}</span>,
};

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
  // Un fichier texte, Markdown ou bureautique : son contenu se charge à l'ouverture et se montre comme un document.
  const ext = (spec.path || "").split("?")[0].split(".").pop()?.toLowerCase() || "";
  const rawText = !!spec.path && TEXT_EXT.test(spec.path.split("?")[0]) && !OFFICE_EXT.test(spec.path.split("?")[0]);
  const office = !!spec.path && OFFICE_EXT.test(spec.path.split("?")[0]);
  const needsText = !!spec.path && (rawText || office);
  const [text, setText] = useState<string | null | undefined>(needsText ? null : undefined);
  useEffect(() => {
    let live = true;
    if (!needsText || text !== null) return;
    const trimmed = (spec.path || "").replace(/^\/opt\/data\/workspace\//, "").split("/").map(encodeURIComponent).join("/");
    // Un fichier bureautique passe par l'extraction du serveur ; un texte se lit tel quel.
    const target = office
      ? `/api/agents/${encodeURIComponent(spec.agentId || "")}/fichier/texte/${trimmed}`
      : `/api/agents/${spec.agentId}/files/raw/${trimmed}`;
    if (!spec.path) return;
    fetch(target, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (live) setText(office ? `# ${spec.title}\n\n${body}` : body); })
      .catch(() => { if (live) setText(undefined); });
    return () => { live = false; };
  }, [needsText, office, spec.path, spec.agentId, spec.title, text]);
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
    <p className="element-origin">{sourceName(spec)}{spec.version && ` · ${t("version {v}", { v: spec.version })}`} · {spec.size == null ? t("Taille non renseignée") : t("{n} octets", { n: spec.size.toLocaleString(locale()) })}</p>
    {spec.description && <p><SensitiveText text={spec.description} /></p>}
    {error ? <p role="alert">{t("Fichier introuvable.")} <button onClick={() => setError(false)}>{t("Réessayer")}</button></p>
      : !loaded ? <div><p>{t("Fichier volumineux.")} <SensitiveText text={spec.description || t("Aperçu sur demande.")} /></p><button onClick={() => setLoaded(true)}>{t("Charger l'aperçu")}</button></div>
      : spec.kind === "image" && url ? <div className="image-stage" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); points.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); const p = [...points.current.values()]; gesture.current = { distance: p.length === 2 ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0, zoom, y: e.clientY }; }}
        onPointerMove={(e) => { if (!points.current.has(e.pointerId)) return; points.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); const p = [...points.current.values()], g = gesture.current; if (p.length === 2 && g?.distance) setZoom(Math.max(1, Math.min(4, g.zoom * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.distance))); }}
        onPointerUp={(e) => { if (points.current.size === 1 && zoom === 1 && gesture.current && e.clientY - gesture.current.y > 120) onClose?.(); points.current.delete(e.pointerId); }} onPointerCancel={(e) => points.current.delete(e.pointerId)}>
        <img src={url} alt={display(spec.description || spec.title)} onError={() => setError(true)} style={{ transform: `scale(${zoom})` }} /><label>{t("Zoom")} <input type="range" min="1" max="4" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label></div>
      : spec.kind === "pdf" && url ? <><div className="flex gap-3 items-center"><button disabled={page === 1} onClick={() => setPage(page - 1)}>{t("Page précédente")}</button><span>{t("Page {n}", { n: page })}{Number(data.pages) > 0 ? ` / ${Number(data.pages)}` : ""}</span><button disabled={Number(data.pages) > 0 && page >= Number(data.pages)} onClick={() => setPage(page + 1)}>{t("Page suivante")}</button><label>{t("Zoom")} <input type="range" min=".5" max="3" step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label></div><SandboxedFrame title={elementName(spec)} src={url.split("#")[0] + `#page=${page}&zoom=${zoom * 100}`} className="element-frame" onError={() => setError(true)} /></>
      : spec.kind === "page" && url ? <SandboxedFrame title={elementName(spec)} src={url} className="element-frame" onError={() => setError(true)} />
      : spec.kind === "video" && url ? <video src={url} controls playsInline preload="metadata" className="element-frame max-h-[70vh] w-full bg-black" onError={() => setError(true)}>{t("Ce format vidéo n'est pas lu par ce navigateur.")} <button onClick={() => download(url, spec.title)}>{t("Télécharger")}</button></video>
      : spec.kind === "audio" && url ? <div className="flex flex-col gap-2 px-4 py-5"><audio src={url} controls preload="metadata" className="w-full" onError={() => setError(true)} /><span className="text-xs text-muted-foreground">{ext ? t("Audio {format}", { format: ext.toUpperCase() }) : t("Audio")} · <button className="cursor-pointer underline" onClick={() => download(url, spec.title)}>{t("télécharger")}</button></span></div>
      : needsText && text ? <div className="element-frame prose-chat max-w-none overflow-auto bg-surface px-6 py-4 text-[15px] leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...SENSITIVE_MARKDOWN, a: TEXT_MARKDOWN.a, img: TEXT_MARKDOWN.img }}>{text}</ReactMarkdown></div>
      : needsText && text !== null && text === undefined ? <p role="alert">{t("Ce fichier n'a pas pu être lu ici. Télécharge-le pour l'ouvrir.")} <button onClick={() => download(url || spec.path || "", spec.title)}>{t("Télécharger")}</button></p>
      : spec.kind === "grid" || spec.kind === "batch" ? <div className="element-grid">{items.map((it, i) => <article key={i}>{elementUrl(String(it.image ?? "")) && <img src={elementUrl(String(it.image))} alt={String(it.title ?? "")} loading="lazy" />}<b><SensitiveText text={String(it.title ?? "")} /></b><p><SensitiveText text={String(it.subtitle ?? "")} /></p></article>)}</div>
      : spec.kind === "chart" && Array.isArray(data.series) && Array.isArray(data.labels) ? <Chart spec={data as unknown as React.ComponentProps<typeof Chart>["spec"]} />
      : ["table", "csv", "chart"].includes(spec.kind) && rows.length ? <div className="overflow-auto"><table><thead><tr>{columns.map((c, i) => <th key={i}>{String(c)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}><SensitiveText text={String(cell)} /></td>)}</tr>)}</tbody></table></div>
      : ["code", "diff"].includes(spec.kind) && typeof data.text === "string" ? <pre className="overflow-auto"><code><SensitiveText text={data.text} /></code></pre>
      : spec.kind === "archive" ? <ul>{!items.length && <li>{t("Liste indisponible. Télécharge le fichier pour le lire.")}</li>}{items.map((it, i) => <li key={i}>{String(it.name || it.title || t("Fichier"))} {it.size != null && `· ${t("{n} octets", { n: String(it.size) })}`}</li>)}</ul>
      : spec.kind === "form" && Array.isArray(data.fields) ? <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); ask(t("Formulaire « {titre} » : {reponses}", { titre: spec.title, reponses: JSON.stringify(fields) })); }}>{data.fields.filter((f): f is string => typeof f === "string").map((f) => <label key={f}>{f}<input className="shell-search block w-full" value={fields[f] ?? ""} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} /></label>)}<button className="shell-primary">{t("Envoyer mes réponses")}</button></form>
      : (spec.kind === "form" || spec.kind === "choice") && Array.isArray(data.options) ? <div className="element-actions">{data.options.map((o, i) => <button key={i} onClick={() => ask(String(o))}>{display(String(o))}</button>)}</div>
      : <div className="element-detail">{Object.entries(data).map(([key, value]) => <p key={key}><b>{t("{nom} :", { nom: key })} </b><SensitiveText text={typeof value === "object" ? JSON.stringify(value) : String(value)} /></p>)}{!Object.keys(data).length && <p>{t("Aperçu indisponible.")}</p>}</div>}
    {(spec.kind === "routine" || spec.kind === "watch") && typeof data.id === "string" && spec.agentId && <label className="shell-row">{t("Active")}<input role="switch" type="checkbox" checked={enabled} onChange={() => void toggle()} /></label>}
    {actionError && <p role="alert">{actionError}</p>}
    <div className="element-actions">{url && appShell() && <button onClick={() => void elementAction("openWith", url, spec.title).catch((e) => setActionError(e.message))}>{t("Ouvrir avec")}</button>}{url && appShell()?.kind === "android" && <button onClick={() => void elementAction("share", url, spec.title).catch((e) => setActionError(e.message))}>{t("Partager")}</button>}{ACTIONS[spec.kind] && <button onClick={() => ask(`${t("{nom} : {texte}", { nom: ACTIONS[spec.kind] ?? "", texte: spec.title })}\n${JSON.stringify(data)}`)}>{ACTIONS[spec.kind]}</button>}{url && <button onClick={() => download(url, spec.title)}>{t("Télécharger")}</button>}</div>
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
      {pending !== null && <DialogContent title={t("Relire avant d'envoyer")}>
        <p>{t("Révèle les données pour vérifier ce que tu envoies à l'agent.")}</p>
        <SensitiveContext.Provider value={!revealed}><pre className="whitespace-pre-wrap"><SensitiveText text={pending} /></pre></SensitiveContext.Provider>
        <button onClick={() => setRevealed(!revealed)}>{revealed ? t("Recacher") : t("Révéler avant d'envoyer")}</button>
        <button disabled={!revealed} onClick={() => { const text = pending; setPending(null); deliver(text); }}>{t("Envoyer à l'agent")}</button>
      </DialogContent>}
    </Dialog>
  </div>;
}
