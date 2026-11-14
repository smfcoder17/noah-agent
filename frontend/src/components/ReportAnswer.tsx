// « Signaler » sous une réponse d'agent (règle de Google sur le contenu généré par IA) : la fenêtre s'ouvre dans l'app,
// sans la quitter. Noah n'a pas de serveur à lui : le signalement part à l'éditeur par un e-mail que la personne relit
// et envoie elle-même. Rien ne part sans ce geste.
import { Flag } from "lucide-react";
import { useState } from "react";
import { EDITEUR_EMAIL } from "@/lib/editeur";
import { COMMENTAIRE_MAX, MOTIFS, reportMailto } from "@/lib/signalement";
import { Button, Dialog, DialogContent, Label, Textarea } from "./ui";

/** Le bouton, et sa fenêtre. `readText` lit la réponse au moment d'ouvrir : le texte affiché, données masquées comprises. */
export function ReportAnswer({ readText }: { readText: () => string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [motif, setMotif] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [sent, setSent] = useState(false);
  const show = () => {
    setText(readText());
    setMotif("");
    setCommentaire("");
    setSent(false);
    setOpen(true);
  };
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Signaler la réponse" title="Signaler cette réponse" onClick={show}>
        <Flag />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title="Signaler cette réponse" description="Offensante, dangereuse ou fausse ? Dis-le à l'éditeur de Noah.">
            {sent ? (
              <div className="flex flex-col gap-4" role="status">
                <p className="text-sm">Merci. Ton app de messagerie a reçu le signalement : relis-le, puis envoie-le.</p>
                <Button className="self-end" onClick={() => setOpen(false)}>Fermer</Button>
              </div>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">Motif</legend>
                  {MOTIFS.map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm">
                      <input type="radio" name="motif" value={m} checked={motif === m} onChange={() => setMotif(m)} />
                      {m}
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="signalement-commentaire">Commentaire (facultatif)</Label>
                  <Textarea id="signalement-commentaire" value={commentaire} maxLength={COMMENTAIRE_MAX} rows={3} onChange={(e) => setCommentaire(e.target.value)} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Ton serveur et ton modèle sont les tiens : Noah n'a pas de serveur pour recevoir ce signalement. Il part par
                  e-mail à l'éditeur ({EDITEUR_EMAIL}), avec le texte de cette réponse. Tu le relis avant de l'envoyer.
                </p>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                  {motif ? (
                    <Button asChild>
                      <a href={reportMailto(motif, commentaire, text)} onClick={() => setSent(true)}>Envoyer par e-mail</a>
                    </Button>
                  ) : (
                    <Button type="button" disabled>Envoyer par e-mail</Button>
                  )}
                </div>
              </form>
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
