// Visionneuse : une image ou un fichier de l'agent s'ouvre ici, par-dessus le chat, sans quitter Noah Agent.
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Button, Dialog, DialogContent } from "./ui";

export type Viewable =
  | { kind: "image"; src: string; title?: string }
  | { kind: "file"; url: string; title: string };

const ViewerContext = createContext<(v: Viewable) => void>(() => {});
export const useViewer = () => useContext(ViewerContext);

export const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(p);
export const canFrame = (p: string) => /\.(html?|pdf|txt|md|csv|json|svg|log)$/i.test(p);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<Viewable | null>(null);
  return (
    <ViewerContext.Provider value={setItem}>
      {children}
      <Dialog open={!!item} onOpenChange={(o) => !o && setItem(null)}>
        {item?.kind === "image" && <ImageView item={item} />}
        {item?.kind === "file" && <FileView item={item} />}
      </Dialog>
    </ViewerContext.Provider>
  );
}

/** Image en PNG, seul format que tous les presse-papiers acceptent. */
async function pngOf(src: string) {
  const blob = await (await fetch(src, { credentials: "same-origin" })).blob();
  return blob.type === "image/png"
    ? blob
    : new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext("2d")!.drawImage(img, 0, 0);
            c.toBlob((b) => (b ? resolve(b) : reject(new Error("conversion"))), "image/png");
          };
          img.onerror = reject;
          img.src = URL.createObjectURL(blob);
        });
}

// L'écriture part tout de suite, dans le clic, avec une image promise : sinon Safari et Chrome
// considèrent que le geste de l'utilisateur est perdu pendant le téléchargement.
const copyImage = (src: string) => navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(src) })]);

function ImageView({ item }: { item: Extract<Viewable, { kind: "image" }> }) {
  const [copied, setCopied] = useState<"ok" | "error" | null>(null);
  const name = item.title || decodeURIComponent(item.src).split(/[/=]/).pop() || "image";
  return (
    <DialogContent title={item.title || "Image"} className="max-w-6xl gap-3 p-4">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-xl bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
        <img src={item.src} alt={item.title || ""} className="max-h-[72dvh] w-auto max-w-full object-contain" />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            copyImage(item.src)
              .then(() => setCopied("ok"))
              .catch(() => setCopied("error"))
          }
        >
          {copied === "ok" ? <Check /> : <Copy />}
          {copied === "ok" ? "Copiée" : copied === "error" ? "Copie impossible ici" : "Copier l'image"}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={item.src} download={name}><Download />Télécharger</a>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={item.src} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
        </Button>
      </div>
    </DialogContent>
  );
}

function FileView({ item }: { item: Extract<Viewable, { kind: "file" }> }) {
  return (
    <DialogContent title={item.title} className="h-[min(88dvh,900px)] max-w-6xl gap-3 p-4">
      <iframe
        src={item.url}
        title={item.title}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="min-h-0 flex-1 rounded-lg border border-border bg-white"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={`${item.url}?download=1`}><Download />Télécharger</a>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a href={item.url} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
        </Button>
      </div>
    </DialogContent>
  );
}
