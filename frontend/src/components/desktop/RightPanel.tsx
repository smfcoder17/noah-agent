import { SensitiveText } from "../SensitiveText";
import { Maximize2, X } from "lucide-react";

export function RightPanel({ title, onClose, onExpand, children }: { title: string; onClose: () => void; onExpand: () => void; children: React.ReactNode }) {
  return <aside className="right-panel" aria-label="Aperçu"><header><b><SensitiveText text={title} /></b><button className="shell-icon" aria-label="Plein écran" onClick={onExpand}><Maximize2 size={18} /></button><button className="shell-icon" aria-label="Fermer l'aperçu" onClick={onClose}><X size={18} /></button></header><div className="right-panel-body">{children}</div></aside>;
}
