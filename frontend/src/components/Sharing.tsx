// Partager un agent avec un autre profil : le droit, l'avertissement sur sa mémoire, ses comptes et ses dossiers, la révocation.
import { TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Agent, del, get, send } from "@/lib/api";
import { Button, Dialog, DialogContent, ErrorText, Input, Label } from "./ui";

type Share = { user_id: number; username: string; droit: Droit };
type Droit = "lecture" | "usage" | "admin";

const RIGHTS: { id: Droit; label: string; hint: string }[] = [
  { id: "lecture", label: "Lecture", hint: "Voir l'agent et les conversations rendues visibles, sans rien écrire." },
  { id: "usage", label: "Usage", hint: "Lui parler dans ses propres conversations et voir ses fichiers." },
  { id: "admin", label: "Admin", hint: "En plus, ses réglages et son écran, sauf le supprimer ou le repartager." },
];

export function ShareDialog({ agent, open, onOpenChange, onChanged }: { agent: Agent; open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title={`Partager ${agent.name}`} description="Chacun garde sa conversation avec l'agent, et l'agent sait à qui il parle.">
          <ShareForm agent={agent} onChanged={onChanged} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ShareForm({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [warning, setWarning] = useState("");
  const [username, setUsername] = useState("");
  const [droit, setDroit] = useState<Droit>("usage");
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState("");
  const base = `/api/agents/${agent.id}/shares`;
  const load = useCallback(() => get<{ partages: Share[]; avertissement: string }>(base).then((r) => {
    setShares(r.partages);
    setWarning(r.avertissement);
  }).catch((e) => setError((e as Error).message)), [base]);
  useEffect(() => {
    load();
  }, [load]);

  const share = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await send(base, { utilisateur: username.trim(), droit, compris: understood }, "PUT");
      setUsername("");
      setUnderstood(false);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const revoke = async (s: Share) => {
    setError("");
    try {
      await del(`${base}/${s.user_id}`);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm text-warn">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>Attention : {warning || "cet agent garde une seule mémoire, un seul navigateur et un seul dossier de travail ; ses comptes connectés et ses dossiers servent à tous ceux avec qui tu le partages."}</span>
      </p>
      {shares && shares.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {shares.map((s) => (
            <li key={s.user_id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{s.username}</span>
              <span className="text-xs text-muted-foreground">{RIGHTS.find((r) => r.id === s.droit)?.label}</span>
              <Button variant="ghost" size="sm" onClick={() => revoke(s)} aria-label={`Révoquer le partage avec ${s.username}`}><X />Révoquer</Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={share} className="flex flex-col gap-3">
        <Label>Nom d'utilisateur du profil<Input required minLength={2} maxLength={64} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></Label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">Droit</legend>
          {RIGHTS.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="droit" className="mt-1" checked={droit === r.id} onChange={() => setDroit(r.id)} />
              <span><b className="font-medium">{r.label}</b> <span className="text-muted-foreground">{r.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          J'ai compris : sa mémoire, son navigateur et ses comptes connectés seront communs.
        </label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="self-start" disabled={!understood}>Partager</Button>
      </form>
    </div>
  );
}
