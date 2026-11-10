// Visionneuse : une image ou un fichier de l'agent s'ouvre ici, par-dessus le chat, sans quitter Noah Agent.
import { Check, Copy } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, lazy, Suspense } from "react";
import { inAndroidApp, nativeElement } from "@/lib/platform";
import { downloadFile } from "@/lib/utils";
import { Button, Dialog, DialogContent } from "./ui";
const ElementViewer = lazy(() => import("./elements/ElementViewer").then((m) => ({ default: m.ElementViewer })));
import { MediaPlayers } from "./elements/MediaPlayers";
import { RightPanel } from "./desktop/RightPanel";
import { kindOfFile, type ElementSpec } from "@/lib/elements";

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
  const [wide, setWide] = useState(() => matchMedia("(min-width:768px)").matches);
  useEffect(() => { const media = matchMedia("(min-width:768px)"); const change = () => setWide(media.matches); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === "Escape") setItem(null); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, []);
  useEffect(() => { const close = () => setItem(null); window.addEventListener("noah:viewer-close", close); return () => window.removeEventListener("noah:viewer-close", close); }, []);
  const view = useCallback((next: Viewable) => {
    const shown: Viewable = next.kind === "image" ? { kind: "element", element: { type: "element", kind: "image", title: next.title || "Image", url: next.src, source: "noah" } } : next.kind === "file" ? { kind: "element", element: { type: "element", kind: kindOfFile(next.url), title: next.title, url: next.url, source: "noah" } } : next;
    if (shown.kind === "element" && shown.element.url && nativeElement(shown.element.kind, shown.element.url, shown.element.title, () => setItem(shown))) return;
    setItem(shown);
  }, []);
  const panel = wide && item?.kind === "element" && !item.fullscreen;
  return <ViewerContext.Provider value={view}><MediaPlayers>{children}
    {panel && item?.kind === "element" && <RightPanel title={item.element.title} onClose={() => setItem(null)} onExpand={() => setItem({ ...item, fullscreen: true })}><Suspense fallback={<p role="status">Chargement…</p>}><ElementViewer key={item.element.title + item.element.url} spec={item.element} onClose={() => setItem(null)} /></Suspense></RightPanel>}
    <Dialog open={!!item && !panel} onOpenChange={(o) => !o && setItem(null)}>
      {item?.kind === "element" && !panel && <DialogContent title={item.element.title} className="max-w-6xl"><ElementViewer key={item.element.title + item.element.url} spec={item.element} onClose={() => setItem(null)} /></DialogContent>}
      {item?.kind === "gone" && <DialogContent title={item.title}><p>Fichier introuvable.</p><button onClick={() => setItem(null)}>Réessayer</button></DialogContent>}
    </Dialog>
  </MediaPlayers></ViewerContext.Provider>;
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
