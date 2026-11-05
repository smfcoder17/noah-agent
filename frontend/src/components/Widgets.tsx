// Widgets que l'agent affiche dans le fil : un bloc ```noah (ou l'ancien ```noah) contenant un objet JSON.
// Graphique, tableau, grille d'éléments, question à choix. Le JSON invalide retombe en bloc de code.
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";
import { Check, Download, ExternalLink, FileText, Maximize2, Reply } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { mediaUrl, previewUrl, rawFileUrl } from "@/lib/api";
import { inAndroidApp, nativeSave } from "@/lib/platform";
import { cn, safeMedia } from "@/lib/utils";
import { AgentContext } from "@/lib/agentContext";
import { useQuotes, widgetQuote } from "@/lib/quotes";
import { Button } from "./ui";
import { canFrame, isImagePath, useDownload, useViewer } from "./Viewer";

type Series = { name?: string; values: number[] };
type ChartSpec = { type: "chart"; title?: string; kind?: "bar" | "line"; labels: string[]; series: Series[]; note?: string };
type TableSpec = { type: "table"; title?: string; columns: string[]; rows: (string | number)[][]; note?: string };
type GridItem = { title: string; subtitle?: string; image?: string; url?: string; badge?: string };
type GridSpec = { type: "grid"; title?: string; items: GridItem[]; note?: string };
type ChoiceSpec = { type: "choice"; question: string; options: string[] };
type PreviewSpec = { type: "preview"; path: string; title?: string; note?: string };
type Spec = ChartSpec | TableSpec | GridSpec | ChoiceSpec | PreviewSpec;

// Palette des séries (distincte des couleurs d'état).
const SERIES = ["#2a47c9", "#0f766e", "#b4541a", "#7c3aed"];

const fmt = (n: number) => new Intl.NumberFormat("fr-FR", { notation: Math.abs(n) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);

const PAGE_WIDTH = "min(calc(100cqw - 2.5rem), 60rem)";

function Frame({ title, note, actions, children, className, style }: { style?: React.CSSProperties; title?: string; note?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section style={style} className={cn("my-3 overflow-hidden rounded-2xl border border-border bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="truncate text-sm font-semibold">{title}</h3>}
            {note && <p className="truncate text-xs text-muted-foreground">{note}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

function toCsv(columns: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [columns, ...rows].map((r) => r.map(cell).join(";")).join("\n");
}

function CsvButton({ columns, rows, name }: { columns: string[]; rows: (string | number)[][]; name: string }) {
  const text = "﻿" + toCsv(columns, rows);
  const href = useMemo(() => URL.createObjectURL(new Blob([text], { type: "text/csv" })), [text]);
  const file = `${name || "donnees"}.csv`;
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} download={file} onClick={(e) => nativeSave(file, "text/csv", text) && e.preventDefault()}><Download />CSV</a>
    </Button>
  );
}

function Chart({ spec }: { spec: ChartSpec }) {
  const [asTable, setAsTable] = useState(false);
  const labels = spec.labels ?? [];
  const series = (spec.series ?? []).filter((s) => Array.isArray(s.values));
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(Number).filter(Number.isFinite)));
  const columns = ["", ...series.map((s, i) => s.name || `Série ${i + 1}`)];
  const rows = labels.map((l, i) => [l, ...series.map((s) => s.values[i] ?? "")]);
  const W = 640, H = 200, pad = 28;
  const step = (W - pad * 2) / Math.max(1, labels.length);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return (
    <Frame
      title={spec.title}
      note={spec.note}
      actions={
        <div className="flex shrink-0 gap-1" role="group" aria-label="Affichage">
          <Button size="sm" variant={asTable ? "outline" : "default"} aria-pressed={!asTable} onClick={() => setAsTable(false)}>Graphique</Button>
          <Button size="sm" variant={asTable ? "default" : "outline"} aria-pressed={asTable} onClick={() => setAsTable(true)}>Tableau</Button>
          <CsvButton columns={columns} rows={rows} name={spec.title ?? "graphique"} />
        </div>
      }
    >
      {asTable ? (
        <TableBody columns={columns} rows={rows} />
      ) : (
        <div className="px-3 pt-2 pb-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={spec.title ?? "Graphique"}>
            <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--border)" />
            {spec.kind === "line"
              ? series.map((s, si) => (
                  <g key={si}>
                    <polyline
                      fill="none"
                      stroke={SERIES[si % SERIES.length]}
                      strokeWidth={2.5}
                      strokeLinejoin="round"
                      points={s.values.map((v, i) => `${pad + step * i + step / 2},${y(Number(v) || 0)}`).join(" ")}
                    />
                    {s.values.map((v, i) => (
                      <circle key={i} cx={pad + step * i + step / 2} cy={y(Number(v) || 0)} r={3.5} fill={SERIES[si % SERIES.length]}>
                        <title>{`${labels[i]} · ${fmt(Number(v) || 0)}`}</title>
                      </circle>
                    ))}
                  </g>
                ))
              : labels.map((_, i) => {
                  const bw = Math.min(56, (step * 0.7) / Math.max(1, series.length));
                  const x0 = pad + step * i + (step - bw * series.length) / 2;
                  return series.map((s, si) => {
                    const v = Number(s.values[i]) || 0;
                    return (
                      <g key={`${i}-${si}`}>
                        <rect x={x0 + bw * si} y={y(v)} width={bw - 3} height={H - pad - y(v)} rx={5} fill={SERIES[si % SERIES.length]} opacity={series.length === 1 && v !== max ? 0.45 : 1}>
                          <title>{`${labels[i]} · ${fmt(v)}`}</title>
                        </rect>
                        {series.length === 1 && (
                          <text x={x0 + bw / 2 - 1.5} y={y(v) - 6} textAnchor="middle" fontSize="11" fill="var(--foreground)" className="tabular-nums">{fmt(v)}</text>
                        )}
                      </g>
                    );
                  });
                })}
            {labels.map((l, i) => (
              <text key={i} x={pad + step * i + step / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">{l}</text>
            ))}
          </svg>
          {series.length > 1 && (
            <div className="flex flex-wrap gap-3 px-2 text-xs text-muted-foreground">
              {series.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} />{s.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}

function TableBody({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-surface">
          <tr>{columns.map((c, i) => <th key={i} className="border-b border-border px-4 py-2 text-left text-xs font-medium text-muted-foreground">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {r.map((v, j) => <td key={j} className={cn("px-4 py-2", typeof v === "number" && "text-right tabular-nums")}>{typeof v === "number" ? fmt(v) : v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Table({ spec }: { spec: TableSpec }) {
  return (
    <Frame title={spec.title} note={spec.note} actions={<CsvButton columns={spec.columns} rows={spec.rows} name={spec.title ?? "tableau"} />}>
      <TableBody columns={spec.columns ?? []} rows={spec.rows ?? []} />
    </Frame>
  );
}

function Grid({ spec }: { spec: GridSpec }) {
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  const src = (image?: string) => (!image ? undefined : image.startsWith("/opt/data/") ? mediaUrl(agentId, image) : /^https?:\/\//.test(image) ? safeMedia(image) : undefined);
  return (
    <Frame title={spec.title} note={spec.note}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
        {(spec.items ?? []).map((it, i) => {
          const body = (
            <>
              <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
                {src(it.image) && <img src={src(it.image)} alt="" loading="lazy" className="size-full object-cover" />}
                {it.badge && <span className="absolute top-1.5 left-1.5 rounded-md bg-surface px-1.5 py-px text-[11px] font-semibold shadow-sm">{it.badge}</span>}
              </div>
              <span className="line-clamp-2 text-[13px] leading-snug font-medium">{it.title}</span>
              {it.subtitle && <span className="text-xs text-muted-foreground tabular-nums">{it.subtitle}</span>}
            </>
          );
          return it.url ? (
            <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" className="group flex min-w-0 flex-col gap-1.5 no-underline">
              {body}
            </a>
          ) : (
            <button
              key={i}
              type="button"
              className="flex min-w-0 cursor-zoom-in flex-col gap-1.5 text-left"
              onClick={() => src(it.image) && view({ kind: "image", src: src(it.image)!, title: it.title })}
            >
              {body}
            </button>
          );
        })}
      </div>
    </Frame>
  );
}

const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

/** Un fichier créé par l'agent, montré dans la conversation : application, page, PDF, image, son, vidéo ou carte de téléchargement. */
function Preview({ spec }: { spec: PreviewSpec }) {
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  const download = useDownload();
  const path = String(spec.path || "");
  const name = path.split("/").pop() || "fichier";
  // Une app est un dossier : son nom parle plus que « index.html ».
  const title = spec.title || (/^index.html?$/i.test(name) ? path.split("/").slice(-2)[0] : name);
  const raw = rawFileUrl(agentId, path);
  const page = /\.html?$/i.test(path);
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (page) previewUrl(agentId, path).then((u) => live && setLink(u), () => live && setLink(raw));
    return () => {
      live = false;
    };
  }, [agentId, path, page, raw]);
  const url = page ? link ?? raw : raw;
  const image = isImagePath(path);
  const frame = !image && canFrame(path);
  const open = () => (image ? view({ kind: "image", src: mediaUrl(agentId, path), title }) : view({ kind: "file", url, title }));
  return (
    <Frame
      title={title}
      note={spec.note ?? name}
      // Une application a besoin de place : elle déborde de la colonne de lecture quand la fenêtre le permet.
      style={page ? { width: PAGE_WIDTH, marginLeft: `calc((100% - ${PAGE_WIDTH}) / 2)` } : undefined}
      actions={
        <div className="flex shrink-0 gap-1">
          {(image || frame) && (
            <Button size="sm" variant="outline" onClick={open}><Maximize2 />Agrandir</Button>
          )}
          {frame && !inAndroidApp() && (
            <Button size="icon-sm" variant="ghost" asChild>
              <a href={url} target="_blank" rel="noopener" aria-label="Ouvrir dans un onglet"><ExternalLink /></a>
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" asChild>
            <a href={`${raw}?download=1`} onClick={(e) => { e.preventDefault(); download(`${raw}?download=1`, name); }} aria-label={`Télécharger ${name}`}><Download /></a>
          </Button>
        </div>
      }
    >
      {AUDIO_RE.test(path) ? (
        <div className="px-4 py-3">
          <audio controls preload="metadata" src={url} className="w-full" />
        </div>
      ) : VIDEO_RE.test(path) ? (
        <video controls preload="metadata" src={url} className="block max-h-[480px] w-full bg-black" />
      ) : image ? (
        <button type="button" onClick={open} className="block w-full cursor-zoom-in bg-muted">
          <img src={mediaUrl(agentId, path)} alt={title} loading="lazy" className="mx-auto max-h-96 object-contain" />
        </button>
      ) : frame && page && !link ? (
        <div className="h-[560px] bg-muted" />
      ) : frame ? (
        <iframe
          src={url}
          title={title}
          loading="lazy"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          className={cn("block w-full border-0 bg-white", page ? "h-[560px]" : "h-80")}
        />
      ) : (
        <a href={`${url}?download=1`} onClick={(e) => { e.preventDefault(); download(`${url}?download=1`, name); }} className="flex items-center gap-3 px-4 py-4 text-sm no-underline hover:bg-muted">
          <FileText className="size-8 text-muted-foreground" />
          <span className="flex flex-col">
            <span className="font-medium">{name}</span>
            <span className="text-xs text-muted-foreground">{inAndroidApp() ? "Toucher pour télécharger" : "Cliquer pour télécharger"}</span>
          </span>
        </a>
      )}
    </Frame>
  );
}

function Choice({ spec }: { spec: ChoiceSpec }) {
  const { say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  // La question n'attend plus de réponse dès qu'un message suit celui-ci.
  const isLast = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const open = isLast && !sent && !running;
  return (
    <section className={cn("my-3 flex flex-col gap-3 rounded-2xl border bg-surface p-4", open ? "border-warn shadow-sm" : "border-border")}>
      <span className={cn("text-[11px] font-semibold uppercase tracking-wide", open ? "text-warn" : "text-muted-foreground")}>
        {open ? "Attend ton choix" : "Choix"}
      </span>
      <p className="text-[15px] font-semibold">{spec.question}</p>
      <div role="radiogroup" aria-label={spec.question} className="flex flex-wrap gap-2">
        {(spec.options ?? []).map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={(sent ?? picked) === o}
            disabled={!open}
            onClick={() => setPicked(o)}
            className={cn(
              "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-muted-foreground/50 bg-surface px-3.5 text-[13px] font-medium disabled:cursor-default",
              (sent ?? picked) === o && "border-2 border-accent bg-accent-soft px-[13px] text-accent",
              !open && (sent ?? picked) !== o && "opacity-60",
            )}
          >
            {sent === o && <Check className="size-3.5" />}{o}
          </button>
        ))}
      </div>
      {open && (
        <div className="flex justify-end">
          <Button
            disabled={!picked}
            onClick={() => {
              if (!picked) return;
              setSent(picked);
              say(picked);
            }}
          >
            Valider ce choix
          </Button>
        </div>
      )}
    </section>
  );
}

/** Un widget qu'on peut joindre au prochain message (« Répondre à ceci »), avec sa place réservée sous lui. */
function Quotable({ spec, children }: { spec: Spec; children: React.ReactNode }) {
  const { add } = useQuotes();
  const quote = widgetQuote(spec as unknown as Record<string, unknown>);
  return (
    <div className="group/quote">
      {children}
      {quote && (
        <div className="-mt-2 mb-1 flex h-7 justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground opacity-0 group-hover/quote:opacity-100 focus-visible:opacity-100"
            onClick={() => add(quote)}
          >
            <Reply />Répondre à ceci
          </Button>
        </div>
      )}
    </div>
  );
}

export function NoahWidget({ code, components }: SyntaxHighlighterProps) {
  let spec: Spec | null = null;
  try {
    spec = JSON.parse(code);
  } catch {
    spec = null;
  }
  // Pendant le streaming, le JSON est incomplet : on attend sans afficher le code brut.
  if (!spec || typeof spec !== "object") {
    return <div className="my-3 h-24 animate-pulse rounded-2xl border border-border bg-muted/60" aria-label="Widget en préparation" />;
  }
  switch (spec.type) {
    case "chart": return <Quotable spec={spec}><Chart spec={spec} /></Quotable>;
    case "table": return <Quotable spec={spec}><Table spec={spec} /></Quotable>;
    case "grid": return <Quotable spec={spec}><Grid spec={spec} /></Quotable>;
    case "choice": return <Choice spec={spec} />;
    case "preview": return <Quotable spec={spec}><Preview spec={spec} /></Quotable>;
    default:
      return <components.Pre><components.Code>{code}</components.Code></components.Pre>;
  }
}
