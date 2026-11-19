// « Corriger » une décision qu'un agent a prise à la place de la personne (0.4.0, lot L2) : sa réponse, et la bascule « Retenir comme règle ».
// Retenue, la correction répond ensuite à la même question sans la déranger. La même fenêtre sert dans la tâche et dans Activité.
import { useState } from "react";
import { t } from "@/i18n";
import { send } from "@/lib/api";
import { Button, Dialog, DialogContent, ErrorText } from "./ui";

export type ACorriger = { id: string; question: string; reponse: string; qui: string };
export const DECISION_CORRIGEE = "noah:decision-corrigee";

export function CorrigerDialog({ cible, onClose }: { cible: ACorriger | null; onClose: () => void }) {
  const [texte, setTexte] = useState("");
  const [regle, setRegle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => { setTexte(""); setError(""); onClose(); };
  const save = async () => {
    if (!cible) return;
    if (!texte.trim()) { setError(t("Écris ta réponse avant d'enregistrer.")); return; }
    setBusy(true);
    setError("");
    try {
      await send(`/api/questions/${encodeURIComponent(cible.id)}/correction`, { correction: texte.trim(), regle });
      window.dispatchEvent(new CustomEvent(DECISION_CORRIGEE, { detail: { id: cible.id, correction: texte.trim(), regle } }));
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!cible} onOpenChange={(o) => { if (!o) close(); }}>
      {cible && (
        <DialogContent title={t("Corriger cette décision")} description={t("Ta réponse remplace celle de l'agent.")} className="max-w-md">
          <div className="modal-body-corriger">
            <div className="xchg">
              <div className="xchg-line"><b>{t("Question")}</b><span>{cible.question}</span></div>
              <div className="xchg-line"><b>{cible.qui}</b><span>{cible.reponse}</span></div>
            </div>
            <label className="stack g4"><b>{t("Ta réponse")}</b>
              <input className="input" value={texte} placeholder={t("Ce que tu aurais répondu")} onChange={(e) => setTexte(e.target.value)} />
            </label>
            <label className="line g12">
              <span className="grow"><b className="block">{t("Retenir comme règle")}</b><span className="help">{t("La prochaine fois, tes agents répondront ainsi sans te déranger.")}</span></span>
              <input type="checkbox" role="switch" checked={regle} onChange={(e) => setRegle(e.target.checked)} aria-label={t("Retenir comme règle")} />
            </label>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close}>{t("Annuler")}</Button>
              <Button disabled={busy} onClick={() => void save()}>{t("Enregistrer")}</Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
