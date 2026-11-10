// Fichiers de l'agent : de vrais dossiers, un tri, et une sélection qu'on donne au chat ou qu'on supprime.
import { ChevronDown, Download, ExternalLink, Eye, FileText, Folder, MessageSquarePlus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, rawFileUrl, send, type WorkspaceFile } from "@/lib/api";
import { useAgentData } from "@/lib/useAgentData";
import { inAndroidApp } from "@/lib/platform";
import { cn, fileSize, messageMoment } from "@/lib/utils";
import { Button, Dialog, DialogContent } from "./ui";
import { canFrame, useDownload } from "./Viewer";

const WORKSPACE = "/opt/data/workspace/";
const ROOT_NAMES: Record<string, string> = { outputs: "Livrables", apps: "Applications", captures: "Captures", uploads: "Envoyés par toi" };
const OPEN_FIRST = new Set(["outputs", "uploads"]);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

type Sort = "recent" | "nom" | "taille";
type Node = { name: string; path: string; files: WorkspaceFile[]; folders: Node[]; all: WorkspaceFile[]; size: number; modified: number };

/** Le chemin donné au chat, lu par l'agent. */
export const giveFilesEvent = "noah:fichiers";

function buildTree(files: WorkspaceFile[]): Node {
  const root: Node = { name: "", path: "", files: [], folders: [], all: [], size: 0, modified: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    const visit = (n: Node) => {
      n.all.push(file);
      n.size += file.size;
      n.modified = Math.max(n.modified, file.modified);
    };
    visit(node);
    parts.slice(0, -1).forEach((part, i) => {
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join("/"), files: [], folders: [], all: [], size: 0, modified: 0 };
        node.folders.push(next);
      }
      node = next;
      visit(node);
    });
    node.files.push(file);
  }
  return root;
}

const byOrder = <T extends { size: number; modified: number }>(sort: Sort, name: (t: T) => string) => (a: T, b: T) =>
  sort === "nom" ? name(a).localeCompare(name(b), "fr") : sort === "taille" ? b.size - a.size : b.modified - a.modified;

export function Files({ agentId, refreshKey, canDelete, onGiven }: { agentId: string; refreshKey: number; canDelete: boolean; onGiven: () => void }) {
  const path = `/api/agents/${agentId}/files`;
  const { data: files, error, setError, load } = useAgentData<WorkspaceFile[]>(path, { freshOnReload: false, refreshKey });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(OPEN_FIRST);
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ce qui a disparu quitte la sélection : on ne supprime jamais ce qu'on ne voit plus.
  useEffect(() => {
    if (files) setPicked((cur) => new Set([...cur].filter((p) => files.some((x) => x.path === p))));
  }, [files]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return !files ? [] : words ? files.filter((f) => f.path.toLowerCase().includes(words)) : files;
  }, [files, query]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  if (error && !files) return <p className="text-sm text-danger">{error}</p>;
  if (!files) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (!files.length) return <p className="text-sm text-muted-foreground">Aucun fichier pour l'instant.</p>;

  const toggle = (paths: string[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      paths.forEach((p) => (on ? next.add(p) : next.delete(p)));
      return next;
    });
  const toggleOpen = (path: string) =>
    setOpened((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Un dossier entièrement choisi se dit par son nom plutôt que fichier par fichier. */
  const chosenPaths = () => {
    const out: string[] = [];
    const walk = (n: Node) => {
      if (n.path && n.all.every((f) => picked.has(f.path))) return void out.push(`${WORKSPACE}${n.path}/`);
      n.files.filter((f) => picked.has(f.path)).forEach((f) => out.push(WORKSPACE + f.path));
      n.folders.forEach(walk);
    };
    walk(buildTree(files));
    return out;
  };
  const giveToChat = () => {
    const paths = chosenPaths();
    const label = paths.length === 1 ? paths[0].replace(WORKSPACE, "") : `${paths.length} éléments de tes fichiers`;
    window.dispatchEvent(new CustomEvent(giveFilesEvent, { detail: { agentId, label, text: `Fichiers de ton dossier de travail :\n${paths.join("\n")}` } }));
    setPicked(new Set());
    onGiven();
  };
  const remove = async () => {
    setBusy(true);
    try {
      await send(`/api/agents/${agentId}/files/supprimer`, { chemins: [...picked] });
      setPicked(new Set());
      setAsking(false);
      load();
    } catch (e) {
      setError((e as Error).message);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };

  const orderFiles = byOrder<WorkspaceFile>(sort, (f) => f.path);
  const orderFolders = byOrder<Node>(sort, (n) => n.name);
  const searching = !!query.trim();

  return (
    <div className="flex min-h-full flex-col gap-3">
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher" aria-label="Chercher un fichier" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier" className="h-8 rounded-lg border border-border bg-surface px-1.5 text-sm">
          <option value="recent">Récents</option>
          <option value="nom">Nom</option>
          <option value="taille">Taille</option>
        </select>
        <Button variant="ghost" size="icon-sm" onClick={load} aria-label="Actualiser"><RefreshCw /></Button>
      </div>

      {!shown.length && <p className="px-2 text-sm text-muted-foreground">Aucun fichier ne correspond.</p>}
      <div className="flex flex-1 flex-col gap-0.5">
        <FolderRows node={tree} depth={0} {...{ agentId, picked, opened, toggle, toggleOpen, orderFiles, orderFolders, searching, setPreview }} />
      </div>

      {picked.size > 0 && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface p-2 shadow-md">
          <span className="mr-auto text-sm font-medium">{picked.size} choisi{picked.size > 1 ? "s" : ""}</span>
          <Button size="sm" onClick={giveToChat}><MessageSquarePlus />Donner au chat</Button>
          {canDelete && <Button size="sm" variant="outline" onClick={() => setAsking(true)}><Trash2 />Supprimer</Button>}
          <Button size="icon-sm" variant="ghost" onClick={() => setPicked(new Set())} aria-label="Tout désélectionner"><X /></Button>
        </div>
      )}

      <Dialog open={asking} onOpenChange={(o) => !o && !busy && setAsking(false)}>
        {asking && (
          <DialogContent title={`Supprimer ${picked.size} fichier${picked.size > 1 ? "s" : ""} ?`} description="Ils quittent la machine de l'agent pour de bon.">
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-sm text-muted-foreground">
              {[...picked].slice(0, 50).map((p) => <li key={p} className="truncate">{p}</li>)}
              {picked.size > 50 && <li>et {picked.size - 50} autres</li>}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAsking(false)} disabled={busy}>Annuler</Button>
              <Button variant="warn" onClick={remove} disabled={busy}><Trash2 />Supprimer</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        {preview && (
          <DialogContent title={preview.title} className="h-[min(85dvh,860px)] max-w-5xl p-4">
            {!inAndroidApp() && (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" asChild>
                  <a href={preview.url} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
                </Button>
              </div>
            )}
            <iframe src={preview.url} title={preview.title} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="min-h-0 flex-1 rounded-lg border border-border bg-white" />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

type RowProps = {
  agentId: string;
  picked: Set<string>;
  opened: Set<string>;
  toggle: (paths: string[], on: boolean) => void;
  toggleOpen: (path: string) => void;
  orderFiles: (a: WorkspaceFile, b: WorkspaceFile) => number;
  orderFolders: (a: Node, b: Node) => number;
  searching: boolean;
  setPreview: (p: { title: string; url: string }) => void;
};

function FolderRows({ node, depth, ...props }: RowProps & { node: Node; depth: number }) {
  const { orderFolders, orderFiles } = props;
  const folders = [...node.folders].sort(orderFolders);
  const files = [...node.files].sort(orderFiles);
  return (
    <>
      {folders.map((f) => <FolderRow key={f.path} node={f} depth={depth} {...props} />)}
      {files.map((f) => <FileRow key={f.path} file={f} depth={depth} {...props} />)}
    </>
  );
}

function FolderRow({ node, depth, ...props }: RowProps & { node: Node; depth: number }) {
  const { agentId, picked, opened, toggle, toggleOpen, searching, setPreview } = props;
  const paths = useMemo(() => node.all.map((f) => f.path), [node.all]);
  const count = paths.filter((p) => picked.has(p)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = count > 0 && count < paths.length;
  }, [count, paths.length]);
  const open = searching || opened.has(node.path);
  const name = (depth === 0 && ROOT_NAMES[node.name]) || node.name;
  const app = node.path.startsWith("apps/") && node.path.split("/").length === 2 && paths.includes(`${node.path}/index.html`);
  return (
    <>
      <div className="flex items-center gap-1.5 rounded-lg py-1 pr-1 hover:bg-muted" style={{ paddingLeft: depth * 14 + 4 }}>
        <input ref={box} type="checkbox" checked={count === paths.length} onChange={(e) => toggle(paths, e.target.checked)} aria-label={`Choisir le dossier ${name}`} className="size-4 shrink-0 accent-[var(--accent)]" />
        <button type="button" onClick={() => toggleOpen(node.path)} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-sm">
          <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium" title={node.path}>{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{paths.length}</span>
        </button>
        {app && <Button variant="outline" size="sm" onClick={() => setPreview({ title: node.name, url: rawFileUrl(agentId, `${node.path}/index.html`) })}><Eye />Ouvrir</Button>}
      </div>
      {open && <FolderRows node={node} depth={depth + 1} {...props} />}
    </>
  );
}

function FileRow({ file, depth, agentId, picked, toggle, setPreview }: RowProps & { file: WorkspaceFile; depth: number }) {
  const download = useDownload();
  const name = file.path.split("/").pop() || file.path;
  const made = name.match(/^(?:image|video|vidéo|musique|audio)-\d{8}-\d{6}-(.+)\.\w+$/i);
  const shown = made ? made[1].replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()) : name;
  const raw = rawFileUrl(agentId, file.path);
  const image = IMAGE.test(file.path);
  return (
    <div data-noah-file={raw} data-noah-name={name} className="group flex items-center gap-1.5 rounded-lg py-1 pr-1 hover:bg-muted" style={{ paddingLeft: depth * 14 + 4 }}>
      <input type="checkbox" checked={picked.has(file.path)} onChange={(e) => toggle([file.path], e.target.checked)} aria-label={`Choisir ${name}`} className="size-4 shrink-0 accent-[var(--accent)]" />
      {image ? (
        <img src={mediaUrl(agentId, WORKSPACE + file.path)} alt="" loading="lazy" className="size-8 shrink-0 rounded-md border border-border object-cover" />
      ) : (
        <FileText className="mx-2 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm" title={file.path}>{shown}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{messageMoment(new Date(file.modified * 1000))} · {fileSize(file.size)}</span>
      </span>
      {(image || canFrame(file.path)) && (
        <Button variant="ghost" size="icon-sm" onClick={() => setPreview({ title: name, url: raw })} aria-label={`Aperçu de ${name}`}><Eye /></Button>
      )}
      <Button variant="ghost" size="icon-sm" asChild>
        <a href={`${raw}?download=1`} onClick={(e) => { e.preventDefault(); download(`${raw}?download=1`, name); }} aria-label={`Télécharger ${name}`}><Download /></a>
      </Button>
    </div>
  );
}
