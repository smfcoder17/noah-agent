// Fenêtre de confirmation commune : une action protégée répond 428, on demande ce qu'il manque (mot de passe, code de l'application,
// ou code reçu par courriel) et la même requête repart avec. Le serveur reste seul juge.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, send } from "@/lib/api";
import { Button, Dialog, DialogContent, ErrorText, Input, Label } from "./ui";
import { t } from "@/i18n";

type Fields = { motdepasse?: string; code?: string; courriel?: string };
type Ask = { message: string; error: string; mail: boolean };
type Answer = Fields | "annule" | "nouveau-code";

function ProofForm({ ask, onAnswer }: { ask: Ask; onAnswer: (a: Answer) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mail, setMail] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  useEffect(() => {
    if (ask.mail) return;
    get<{ active: boolean }>("/api/me/double-verification").then((s) => setNeedsCode(s.active)).catch(() => {});
  }, [ask.mail]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // la fenêtre est rendue dans le formulaire de l'action : son envoi ne doit pas le relancer
    onAnswer(ask.mail ? { courriel: mail.trim() } : { motdepasse: password, code });
    setPassword("");
    setCode("");
    setMail("");
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {ask.mail ? (
        <Label>
          {t("Code reçu par courriel")}
          <Input id="proof-mail" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={16} className="font-mono tracking-widest" value={mail} onChange={(e) => setMail(e.target.value)} />
        </Label>
      ) : (
        <>
          <Label>
            {t("Ton mot de passe")}
            <Input id="proof-password" required autoFocus type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          {needsCode && (
            <Label>
              {t("Code de l'application, ou code de secours")}
              <Input id="proof-code" required autoComplete="one-time-code" maxLength={32} className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
            </Label>
          )}
        </>
      )}
      <ErrorText>{ask.error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t("Confirmer")}</Button>
        <Button type="button" variant="ghost" onClick={() => onAnswer("annule")}>{t("Annuler")}</Button>
        {ask.mail && <Button type="button" variant="ghost" onClick={() => onAnswer("nouveau-code")}>{t("Recevoir un nouveau code")}</Button>}
      </div>
    </form>
  );
}

/** `withProof` envoie la requête et rend sa réponse, ou null si la personne a annulé. Les autres erreurs partent à l'appelant. */
export function useProof() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const answer = useRef<((a: Answer) => void) | null>(null);

  const withProof = useCallback(async <T = { ok: boolean },>(path: string, body: object = {}, method = "POST"): Promise<T | null> => {
    const prompt = (next: Ask) =>
      new Promise<Answer>((resolve) => {
        answer.current = resolve;
        setAsk(next);
      });
    let extra: Fields = {};
    let mail = false;
    let asked = false;
    let message = "";
    try {
      for (;;) {
        try {
          return await send<T>(path, { ...body, ...extra }, method);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          if (e.courriel) mail = true;
          // Faux mot de passe ou faux code : la fenêtre reste ouverte. Le reste (nom déjà pris…) revient à l'écran qui a demandé.
          if (e.status !== 428 && !(asked && (e.status === 400 || e.status === 429))) throw e;
          if (e.status === 428) message = e.message;
          const reply = await prompt({ message, error: e.status === 428 ? "" : e.message, mail });
          if (reply === "annule") return null;
          asked = true;
          if (reply === "nouveau-code") {
            extra = {};
            mail = false;
          } else {
            extra = { ...extra, ...reply };
          }
        }
      }
    } finally {
      answer.current = null;
      setAsk(null);
    }
  }, []);

  const proofDialog = useMemo(
    () =>
      ask && (
        <Dialog open onOpenChange={(open) => !open && answer.current?.("annule")}>
          <DialogContent title={ask.mail ? t("Regarde ta boîte de courriel") : t("Confirme que c'est toi")} description={ask.message || undefined}>
            <ProofForm ask={ask} onAnswer={(a) => answer.current?.(a)} />
          </DialogContent>
        </Dialog>
      ),
    [ask],
  );
  return { withProof, proofDialog };
}
