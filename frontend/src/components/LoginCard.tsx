// La carte « Se connecter à… » : ce que la personne saisit part vers Noah Agent, qui le pose dans la page. L'agent ne le reçoit pas.
// Un vrai formulaire : un gestionnaire de mots de passe s'y déclenche. Rien ne reste à l'écran ni dans le stockage du navigateur.
import { Check, KeyRound, MonitorPlay, Trash2, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { ApiError, get, type LoginAsked, request, send } from "@/lib/api";
import { Button, ErrorText, Input } from "./ui";

export type LoginResult = "envoye" | "meme" | "refuse" | "echec";

const LOGIN_DONE: Record<LoginResult, string> = {
  envoye: "Formulaire envoyé à la page",
  meme: "Envoyé, mais la page n'a pas changé : le site a peut-être refusé",
  refuse: "Pas maintenant",
  echec: "La connexion n'a pas abouti, ton agent le sait",
};

export function LoginCard({ agentId, asked, onDone }: { agentId: string; asked: LoginAsked; onDone: (result: LoginResult) => void }) {
  const code = asked.type === "code";
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Le navigateur remplirait sinon ces champs avec le mot de passe de Noah lui-même, qui partirait vers l'autre site.
  // En lecture seule jusqu'au premier geste : un gestionnaire reste proposé dès qu'on touche au champ.
  const [touched, setTouched] = useState(false);
  const ids = useId();
  const url = `/api/agents/${agentId}/connexions/${asked.id}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = code ? { code: secret } : { identifiant: identifier, mot_de_passe: secret, retenir: remember };
      const done = await send<{ page?: string }>(url, body);
      setIdentifier("");
      setSecret("");
      onDone(done.page === "meme" ? "meme" : "envoye");
    } catch (e) {
      setSecret("");
      if (e instanceof ApiError && e.status === 400) setError(e.message); // champ manquant : la demande attend toujours
      else onDone("echec");
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    setError("");
    try {
      await send(url, { refuser: true });
      setSecret("");
      onDone("refuse");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} method="post" action="#" autoComplete="on" className="my-2 flex w-full max-w-md flex-col gap-3 rounded-xl border border-warn bg-warn-soft p-3.5">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-sm font-semibold">{code ? `Code demandé par ${asked.site}` : `Se connecter à ${asked.site}`}</span>
          <span className="break-all text-xs text-muted-foreground">{asked.origine}</span>
        </div>
      </div>
      <p className="text-sm">{code ? "Le code va directement dans la page, ton agent ne le voit pas." : "Le mot de passe va directement dans la page, ton agent ne le voit pas."}</p>
      {!asked.chiffre && (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />Cette page n'est pas chiffrée (pas de https) : ce que tu envoies peut être lu en route.
        </p>
      )}
      {code ? (
        <label htmlFor={`${ids}-code`} className="flex flex-col gap-1 text-xs font-medium">
          Code
          <Input id={`${ids}-code`} name="one-time-code" autoComplete="one-time-code" inputMode="numeric" maxLength={16} required value={secret} onChange={(e) => setSecret(e.target.value)} className="h-9 bg-background" />
        </label>
      ) : (
        <>
          <label htmlFor={`${ids}-id`} className="flex flex-col gap-1 text-xs font-medium">
            Identifiant
            <Input id={`${ids}-id`} name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={320} required={asked.identifiant_requis} readOnly={!touched} onFocus={() => setTouched(true)} value={identifier} onChange={(e) => setIdentifier(e.target.value)} className="h-9 bg-background" />
          </label>
          <label htmlFor={`${ids}-mdp`} className="flex flex-col gap-1 text-xs font-medium">
            Mot de passe
            <Input id={`${ids}-mdp`} name="password" type="password" autoComplete="current-password" maxLength={1024} required readOnly={!touched} onFocus={() => setTouched(true)} value={secret} onChange={(e) => setSecret(e.target.value)} className="h-9 bg-background" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-accent" />
            Retenir pour que ton agent se reconnecte sans te redemander
          </label>
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="warn" size="sm" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={decline}>Pas maintenant</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => window.dispatchEvent(new Event("noah:voir-ecran"))}><MonitorPlay />Prendre le contrôle du navigateur</Button>
      </div>
    </form>
  );
}

/** Après la réponse : une ligne à la place de la carte, sans rien de ce qui a été saisi. */
export function LoginDone({ asked, result }: { asked: LoginAsked; result: LoginResult }) {
  return (
    <p className="my-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
      {result === "envoye" ? <Check className="size-3.5 shrink-0 text-ok" /> : <X className="size-3.5 shrink-0" />}
      <span className="min-w-0">{asked.site} · {LOGIN_DONE[result]}</span>
    </p>
  );
}

type SavedLogin = { id: string; site: string; origine: string };

/** Dans Connexions : les sites où l'agent se reconnecte seul. Les noms de sites seulement : ni identifiant ni mot de passe ne reviennent ici. */
export function SavedLogins({ agentId }: { agentId: string }) {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => get<SavedLogin[]>(`/api/agents/${agentId}/coffre`).then(setLogins).catch((e) => setError((e as Error).message)), [agentId]);
  useEffect(() => void load(), [load]);
  const forget = async (login: SavedLogin) => {
    setError("");
    try {
      await request(`/api/agents/${agentId}/coffre/${login.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!logins?.length && !error) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2.5">
      <span className="text-sm font-medium">Sites où ton agent se reconnecte seul</span>
      <ul className="flex flex-col gap-1">
        {logins?.map((login) => (
          <li key={login.id} className="flex items-center gap-2 text-sm">
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={login.origine}>{login.site}</span>
            <Button variant="ghost" size="sm" aria-label={`Oublier ${login.site}`} onClick={() => forget(login)}><Trash2 />Oublier</Button>
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
