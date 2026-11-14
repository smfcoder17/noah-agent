import { ArrowLeft, X } from "lucide-react";
import { Dialog, DialogContent } from "../ui";
import { t } from "@/i18n";

export function ObjectPage({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title={title} className="object-page" onBack={onClose}>{children}</DialogContent></Dialog>;
}
export function PageHeader({ title, onBack, close = false, className = "" }: { title: string; onBack: () => void; close?: boolean; className?: string }) {
  return <header className={"page-header " + className}><button className="shell-icon fill" aria-label={close ? t("Fermer") : t("Retour")} onClick={onBack}>{close ? <X /> : <ArrowLeft />}</button><h2>{title}</h2><span /></header>;
}
