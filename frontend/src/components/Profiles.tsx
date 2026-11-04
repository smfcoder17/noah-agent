// Réglages > Profils : le propriétaire crée, plafonne et supprime les profils de ce serveur. Le serveur reste seul juge.
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { del, get, send } from "@/lib/api";
import { money } from "@/lib/utils";
import { Button, ErrorText, Input, Label } from "./ui";

type Profile = {
  id: number;
  username: string;
  role: "owner" | "member";
  budget: number | null;
  depense: number;
  agents: { id: string; name: string }[];
  appareils: number;
};

export function Profiles() {
  const [list, setList] = useState<Profile[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => get<{ profils: Profile[] }>("/api/profiles").then((r) => setList(r.profils)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture des profils…</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Chaque profil a ses appareils, ses agents et son budget, et ne voit rien de ceux des autres. Toi non plus : tu ne vois
        l'agent d'un profil que s'il te le partage. Tous passent par le fournisseur et la clé de ce serveur.
      </p>
      <ErrorText>{error}</ErrorText>
      <ul className="flex flex-col gap-2">
        {list.map((p) => <ProfileRow key={p.id} profile={p} onChanged={load} onError={setError} />)}
      </ul>
      <NewProfile onCreated={load} />
    </div>
  );
}

function ProfileRow({ profile: p, onChanged, onError }: { profile: Profile; onChanged: () => void; onError: (m: string) => void }) {
  const [budget, setBudget] = useState(p.budget != null ? String(p.budget) : "");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const saveBudget = async () => {
    if (budget === (p.budget != null ? String(p.budget) : "")) return;
    try {
      await send(`/api/profiles/${p.id}`, { budget: budget === "" ? null : Number(budget) }, "PATCH");
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const remove = async (agents?: "transferer" | "supprimer") => {
    setBusy(true);
    try {
      await del(`/api/profiles/${p.id}${agents ? `?agents=${agents}` : ""}`);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };
  const names = p.agents.map((a) => a.name).join(", ");
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{p.username}{p.role === "owner" && <span className="ml-2 text-xs font-medium text-muted-foreground">propriétaire</span>}</p>
          <p className="text-xs text-muted-foreground">
            {p.agents.length ? `${p.agents.length} agent${p.agents.length > 1 ? "s" : ""} : ${names}` : "Aucun agent"} · {p.appareils} appareil{p.appareils > 1 ? "s" : ""} · {money(p.depense)} $ ce mois-ci
          </p>
        </div>
        <Label className="flex-row items-center gap-2 text-xs font-normal text-muted-foreground">
          Plafond du mois ($)
          <Input type="number" min={0} step={1} placeholder="Aucun" className="h-8 w-24" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={saveBudget} />
        </Label>
        {p.role !== "owner" && (
          <Button variant="ghost" size="icon-sm" aria-label={`Supprimer le profil ${p.username}`} title="Supprimer ce profil" onClick={() => setDeleting(!deleting)}><Trash2 /></Button>
        )}
      </div>
      {deleting && (
        <div className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm">
          <p>
            Supprimer {p.username} coupe tout de suite ses sessions et ses appareils, et efface ses conversations sur les agents qu'on lui avait partagés.
            {p.agents.length > 0 && ` Ses agents (${names}) : à toi de choisir.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {p.agents.length > 0 ? (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => remove("transferer")}>Me transférer ses agents</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => remove("supprimer")}>Effacer aussi ses agents et leurs fichiers</Button>
              </>
            ) : (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => remove()}>Supprimer ce profil</Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>Annuler</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function NewProfile({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send("/api/profiles", { username: username.trim(), password, budget: budget === "" ? null : Number(budget) });
      setUsername("");
      setPassword("");
      setBudget("");
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <form onSubmit={create} className="flex flex-col gap-3 rounded-2xl border border-dashed border-border p-4">
      <p className="text-sm font-semibold">Nouveau profil</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label>Nom d'utilisateur<Input required minLength={2} maxLength={64} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></Label>
        <Label>Mot de passe initial<Input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
        <Label>Plafond du mois ($)<Input type="number" min={0} step={1} placeholder="Aucun" value={budget} onChange={(e) => setBudget(e.target.value)} /></Label>
      </div>
      <p className="text-xs text-muted-foreground">Transmets-lui ce mot de passe toi-même : il le remplacera dans Réglages &gt; Appareils.</p>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" className="self-start" disabled={busy}><UserPlus />Créer le profil</Button>
    </form>
  );
}

/** Le mot de passe initial vient du propriétaire : son titulaire le remplace ici. */
export function MyPassword() {
  const [actuel, setActuel] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await send("/api/me/password", { actuel, nouveau });
      setActuel("");
      setNouveau("");
      setState({ ok: true });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };
  return (
    <form onSubmit={change} className="mt-4 flex flex-col gap-3 rounded-2xl border border-border p-4">
      <p className="text-sm font-semibold">Changer mon mot de passe</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label>Mot de passe actuel<Input required type="password" autoComplete="current-password" value={actuel} onChange={(e) => setActuel(e.target.value)} /></Label>
        <Label>Nouveau mot de passe<Input required type="password" minLength={8} autoComplete="new-password" value={nouveau} onChange={(e) => setNouveau(e.target.value)} /></Label>
      </div>
      <ErrorText>{state.error}</ErrorText>
      {state.ok && <p className="text-sm text-ok">Mot de passe changé. Tes autres appareils sont déconnectés.</p>}
      <Button type="submit" variant="outline" className="self-start">Changer</Button>
    </form>
  );
}
