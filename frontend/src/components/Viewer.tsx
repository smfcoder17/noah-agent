// Visionneuse : une image ou un fichier de l'agent s'ouvre ici, par-dessus le chat, sans quitter Noah Agent.
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { createContext, useCallback, useContext, useState } from "react";
import { inAndroidApp } from "@/lib/platform";
import { downloadFile } from "@/lib/utils";
import { Button, Dialog, DialogContent } from "./ui";
import { ElementViewer } from "./elements/ElementViewer";
import { MediaPlayers } from "./elements/MediaPlayers";
import { SandboxedFrame } from "./elements/SandboxedFrame";
import type { ElementSpec } from "@/lib/elements";

export type Viewable =
  | { kind: "element"; element: ElementSpec; fullscreen?: boolean }
  | { kind: "image"; src: string; title?: string }
  | { kind: "file"; url: string; title: string }
  | { kind: "gone"; title: string };

const ViewerContext = createContext<(v: Viewable) => void>(() => {});
export const useViewer = () => useContext(ViewerContext);

/** Télécharge sans quitter Noah Agent ; si le serveur ne donne pas le fichier, la visionneuse le dit. */
export function useDownload() {
  const view = useViewer();
  return useCallback((url: string, title: string) => downloadFile(url, () => view({ kind: "gone", title })), [view]);
}

export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(p);
/** Dans l'app Android, un cadre PDF reste blanc et un cadre CSV se télécharge tout seul : ces fichiers ne s'y montrent pas. */
export const canFrame = (p: string) => (inAndroidApp() ? /\.(html?|txt|md|json|svg|log)$/i : /\.(html?|pdf|txt|md|csv|json|svg|log)$/i).test(p.split(/[?#]/, 1)[0]);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<Viewable | null>(null);
  return (
    <ViewerContext.Provider value={setItem}>
      <MediaPlayers>
      {children}
      <Dialog open={!!item} onOpenChange={(o) => !o && setItem(null)}>
        {item?.kind === "image" && <ImageView item={item} />}
        {item?.kind === "file" && <FileView item={item} />}
        {item?.kind === "element" && <DialogContent title={item.element.title} className="max-w-6xl"><ElementViewer spec={item.element} /></DialogContent>}
        {item?.kind === "gone" && (
          <DialogContent title={item.title} className="max-w-md gap-3 p-4">
            <p className="text-sm">Fichier indisponible pour l'instant. Réessaie dans un moment : il a peut-être aussi été déplacé ou supprimé.</p>
          </DialogContent>
        )}
      </Dialog>
      </MediaPlayers>
    </ViewerContext.Provider>
  );
}

/** Image en PNG, seul format que tous les presse-papiers acceptent. */
async function pngOf(src: string) {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error("image indisponible");
  const blob = await response.blob();
  return blob.type === "image/png"
    ? blob
    : new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext("2d")!.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            c.toBlob((b) => (b ? resolve(b) : reject(new Error("conversion"))), "image/png");
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image illisible"));
          };
          img.src = url;
        });
}

// L'écriture part tout de suite, dans le clic, avec une image promise : sinon Safari et Chrome
// considèrent que le geste de l'utilisateur est perdu pendant le téléchargement.
// Sans HTTPS, le navigateur n'offre pas de presse-papiers : `navigator.clipboard` n'existe pas.
async function copyImage(src: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("presse-papiers indisponible");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(src) })]);
}

/** Copie une image dans le presse-papiers. `compact` : l'icône seule sur un écran étroit, le résultat restant toujours écrit. */
export function CopyImageButton({ src, compact }: { src: string; compact?: boolean }) {
  const [copied, setCopied] = useState<"ok" | "error" | null>(null);
  const label = copied === "ok" ? "Copiée" : copied === "error" ? "Copie impossible ici" : compact ? "Copier" : "Copier l'image";
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={() => copyImage(src).then(() => setCopied("ok"), () => setCopied("error"))}
    >
      {copied === "ok" ? <Check /> : <Copy />}
      <span className={compact && !copied ? "max-sm:hidden" : undefined}>{label}</span>
    </Button>
  );
}

function ImageView({ item }: { item: Extract<Viewable, { kind: "image" }> }) {
  const download = useDownload();
  const name = item.title || decodeURIComponent(item.src).split(/[/=]/).pop() || "image";
  // L'app Android ne suit pas l'attribut download : une image de l'agent passe par le téléchargement de Noah.
  const ownMedia = /\/media\?path=/.test(item.src);
  return (
    <DialogContent title={item.title || "Image"} className="max-w-6xl gap-3 p-4">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-xl bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
        <img src={item.src} alt={item.title || ""} className="max-h-[72dvh] w-auto max-w-full object-contain" />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <CopyImageButton src={item.src} />
        <Button variant="outline" size="sm" asChild>
          <a
            href={item.src}
            download={name}
            onClick={(e) => {
              if (!ownMedia) return;
              e.preventDefault();
              download(`${item.src}&download=1`, name);
            }}
          >
            <Download />Télécharger
          </a>
        </Button>
        {!inAndroidApp() && (
          <Button variant="ghost" size="sm" asChild>
            <a href={item.src} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
          </Button>
        )}
      </div>
    </DialogContent>
  );
}

function FileView({ item }: { item: Extract<Viewable, { kind: "file" }> }) {
  const download = useDownload();
  return (
    <DialogContent title={item.title} className="h-[min(88dvh,900px)] max-w-6xl gap-3 p-4">
      <SandboxedFrame
        src={item.url}
        title={item.title}
        className="min-h-0 flex-1 rounded-lg border border-border bg-white"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={`${item.url}?download=1`} onClick={(e) => { e.preventDefault(); download(`${item.url}?download=1`, item.title); }}><Download />Télécharger</a>
        </Button>
        {!inAndroidApp() && (
          <Button variant="ghost" size="sm" asChild>
            <a href={item.url} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
          </Button>
        )}
      </div>
    </DialogContent>
  );
}
