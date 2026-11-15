// Aperçu d'un fichier de l'agent, dans le panneau même : texte, Markdown rendu, image, PDF, page HTML en bac à sable.
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { rawFileUrl } from "@/lib/api";
import { kindOfFile, type ElementSpec } from "@/lib/elements";
import { t } from "@/i18n";

const ElementViewer = lazy(() => import("./elements/ElementViewer").then((m) => ({ default: m.ElementViewer })));

export const WORKSPACE = "/opt/data/workspace/";

/** La fiche d'aperçu d'un fichier du dossier de travail : le chemin sert à lire un texte, l'adresse brute à tout le reste. */
export function fileSpec(agentId: string, path: string, size?: number): ElementSpec {
  const name = path.split("/").pop() || path;
  return { type: "element", kind: kindOfFile(path), title: name, url: rawFileUrl(agentId, path), path: WORKSPACE + path, agentId, source: "noah", size };
}

export function FilePreview({ agentId, path, size, onBack, backLabel }: { agentId: string; path: string; size?: number; onBack: () => void; backLabel: string }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus({ preventScroll: true }), [path]);
  const spec = fileSpec(agentId, path, size);
  return (
    <section className="file-preview" aria-label={t("Aperçu de {nom}", { nom: spec.title })} data-preview={path}>
      <div className="file-preview-head">
        <button ref={back} type="button" className="shell-icon" aria-label={backLabel} title={backLabel} onClick={onBack}><ArrowLeft size={18} /></button>
        <b className="truncate" title={path}>{spec.title}</b>
      </div>
      <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("Chargement…")}</p>}>
        <ElementViewer key={path} spec={spec} />
      </Suspense>
    </section>
  );
}
