// Une question d'un agent (0.4.0, lot L2) : la même carte dans « Pour toi », dans la ligne de tâche du fil et sur la page de la tâche.
// Elle dit qui demande (et par qui la question est passée), pour quelle tâche, la question, le pourquoi et les choix. On répond par un choix
// ou par « Autre réponse » ; la réponse débloque l'agent sans ouvrir son fil, et la question disparaît partout (une seule ligne côté serveur).
import { useState } from "react";
import { t } from "@/i18n";
import { type QuestionCarte, send } from "@/lib/api";
import { ErrorText } from "./ui";

/** Un événement de fenêtre prévient les autres lieux où la même question s'affiche : elle y disparaît sans attendre le bus. */
export const QUESTION_REPONDUE = "noah:question-repondue";

const reserveDite = (r: string): string => (r === "payer" ? t("Paiement") : r === "supprimer" ? t("Suppression définitive") : r === "secrets" ? t("Secrets et droits") : r === "publier" ? t("Première publication") : r);

export function CheminQuestion({ q, onTache }: { q: QuestionCarte; onTache?: () => void }) {
  const [premier, second] = q.chemin;
  const qui = second ? t("{a}, transmis par {b}", { a: premier?.nom ?? q.de_nom, b: second.nom }) : (premier?.nom ?? q.de_nom);
  const lien = q.tache ? t("tâche « {titre} »", { titre: q.tache }) : "";
  // Une seule ligne : « Hugo, transmis par Noah · tâche « … » », la tâche en lien bleu qui l'ouvre.
  return (
    <p data-chemin className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground">
      <span className="shrink-0">{qui}</span>
      {lien && <><span aria-hidden className="shrink-0">·</span>{onTache ? <button type="button" className="min-w-0 cursor-pointer truncate text-[var(--accent)] hover:underline" onClick={onTache}>{lien}</button> : <span className="min-w-0 truncate">{lien}</span>}</>}
      {q.reserve && <span className="pill wait shrink-0">{reserveDite(q.reserve)}</span>}
    </p>
  );
}

/** Les boutons de choix et le champ « Autre réponse ». `onDone` : la réponse est partie. */
export function ChoixQuestion({ q, onDone }: { q: QuestionCarte; onDone: (reponse: string) => void }) {
  const [libre, setLibre] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (reponse: string) => {
    const text = reponse.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      await send(`/api/questions/${encodeURIComponent(q.id)}/reponse`, { reponse: text });
      window.dispatchEvent(new CustomEvent(QUESTION_REPONDUE, { detail: { id: q.id, reponse: text } }));
      onDone(text);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409) {  // déjà répondue ailleurs : elle n'attend plus rien
        window.dispatchEvent(new CustomEvent(QUESTION_REPONDUE, { detail: { id: q.id, reponse: "" } }));
        onDone("");
        return;
      }
      setError(t("La réponse n'est pas partie : {erreur}", { erreur: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack g12">
      {q.choix.length > 0 && (
        <div className="line wrap g8">
          {q.choix.map((c) => <button key={c} type="button" className="btn btn-choice" disabled={busy} onClick={() => void answer(c)}>{c}</button>)}
        </div>
      )}
      {q.libre && (
        <form className="line g8" onSubmit={(e) => { e.preventDefault(); void answer(libre); }}>
          <label className="sr-only" htmlFor={`libre-${q.id}`}>{t("Autre réponse")}</label>
          <input id={`libre-${q.id}`} className="input grow" value={libre} placeholder={t("Autre réponse")} onChange={(e) => setLibre(e.target.value)} />
          <button type="submit" className="btn" disabled={busy}>{t("Envoyer")}</button>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** « Tu as répondu : X. » : ce qui reste de la carte une fois la réponse partie. */
export function QuestionRepondue({ q, reponse, court }: { q: QuestionCarte; reponse: string; court?: boolean }) {
  return <span className="grow" style={{ minWidth: 200 }}>{!court && <><b>{q.titre}</b><br /></>}{reponse ? <>{t("Tu as répondu : ")}<b>{reponse}</b>.</> : t("Cette question est réglée.")}</span>;
}

/** La carte entière : « Pour toi » et la page de la tâche. `dansTache` : une ligne de tâche la montre sans cadre. */
export function QuestionCard({ q, onTache, dansTache = false }: { q: QuestionCarte; onTache?: () => void; dansTache?: boolean }) {
  const [reponse, setReponse] = useState<string | null>(null);
  if (reponse !== null) return <div className={dansTache ? "line wrap g8" : "card done"}><QuestionRepondue q={q} reponse={reponse} court={dansTache} /></div>;
  if (dansTache) {
    return (
      <div className="stack g8" data-question={q.id}>
        <CheminQuestion q={q} onTache={onTache} />
        {q.pourquoi && <p className="small soft text-[13px] text-muted-foreground">{q.pourquoi}</p>}
        <p><b>{q.titre}</b></p>
        <ChoixQuestion q={q} onDone={setReponse} />
      </div>
    );
  }
  return (
    <section className="card" data-question={q.id}>
      <CheminQuestion q={q} onTache={onTache} />
      <h2>{q.titre}</h2>
      {q.pourquoi && <p className="soft text-muted-foreground">{q.pourquoi}</p>}
      <ChoixQuestion q={q} onDone={setReponse} />
    </section>
  );
}
