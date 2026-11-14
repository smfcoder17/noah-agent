// Réglages > Personnes : le propriétaire crée, plafonne et supprime les profils de ce serveur, réinitialise un mot de passe, voit et
// coupe les appareils de chacun. Écrit pour marcher à largeur de téléphone. Le serveur reste seul juge.
import { Globe, KeyRound, Laptop, Loader2, MonitorSmartphone, Smartphone, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { locale, t } from "@/i18n";
import { get, send } from "@/lib/api";
import { money } from "@/lib/utils";
import { useProof } from "./Proof";
import { Button, ErrorText, Input, Label } from "./ui";

type Profile = {
  id: number;
  username: string;
  role: "owner" | "member";
  budget: number | null;
  depense: number;
  agents: { id: string; name: string }[];
  appareils: number;
  double: boolean;
};
type Device = { id: string; nom: string; type: string; depuis: string | null; vu: string | null; ip: string; actuel: boolean };

const ICONS: Record<string, typeof Globe> = { web: Globe, desktop: Laptop, android: Smartphone, ios: Smartphone };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale(),{ day: "numeric", month: "long", year: "numeric" }) : "");

export function Profiles() {
  const [list, setList] = useState<Profile[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => get<{ profils: Profile[] }>("/api/profiles").then((r) => setList(r.profils)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture des profils…")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <ErrorText>{error}</ErrorText>
      <ul className="flex flex-col gap-2">
        {list.map((p) => <ProfileRow key={p.id} profile={p} onChanged={load} onError={setError} />)}
      </ul>
      <NewProfile onCreated={load} />
    </div>
  );
}

/** Les appareils d'un profil : nom, adresse, dates. Couper l'un d'eux demande ta preuve. */
function ProfileDevices({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [list, setList] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const { withProof, proofDialog } = useProof();
  const load = useCallback(() => get<{ appareils: Device[] }>(`/api/profiles/${profile.id}/appareils`).then((r) => setList(r.appareils)).catch((e) => setError((e as Error).message)), [profile.id]);
  useEffect(() => {
    load();
  }, [load]);
  const revoke = async (d: Device) => {
    setError("");
    try {
      if (await withProof(`/api/profiles/${profile.id}/appareils/${d.id}`, {}, "DELETE")) {
        load();
        onChanged();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      {list && !list.length && <p className="text-xs text-muted-foreground">{t("Aucun appareil connecté.")}</p>}
      {list?.map((d) => {
        const Icon = ICONS[d.type] ?? Globe;
        return (
          <div key={d.id} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2" data-appareil={d.nom}>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">{d.nom || t("Appareil")}{d.actuel && <span className="ml-2 text-xs text-ok">{t("cet appareil")}</span>}</p>
              <p className="break-words text-xs text-muted-foreground">{[d.ip, d.depuis && t("relié le {date}", { date: day(d.depuis) }), d.vu && t("vu le {date}", { date: day(d.vu) })].filter(Boolean).join(" · ")}</p>
            </div>
            {!d.actuel && <Button size="sm" variant="ghost" aria-label={t("Déconnecter {nom}", { nom: d.nom || t("cet appareil") })} onClick={() => revoke(d)}><Trash2 /></Button>}
          </div>
        );
      })}
      <ErrorText>{error}</ErrorText>
      {proofDialog}
    </div>
  );
}

/** Mot de passe oublié d'un profil : un temporaire, à lui transmettre ; il le remplacera à sa connexion. */
function ResetPassword({ profile, onDone, onCancel }: { profile: Profile; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { withProof, proofDialog } = useProof();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (await withProof(`/api/profiles/${profile.id}/mot-de-passe`, { nouveau: password })) return onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm">
      <p>{t("{nom} a oublié son mot de passe ? Choisis-en un temporaire et transmets-le lui toi-même. Toutes ses sessions se ferment, et il devra le remplacer à sa prochaine connexion.", { nom: profile.username })}</p>
      <Label>
        {t("Mot de passe temporaire")}
        <Input id={`reset-${profile.id}`} required type="password" minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Label>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" variant="danger" disabled={busy}>{t("Réinitialiser son mot de passe")}</Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>{t("Annuler")}</Button>
      </div>
      {proofDialog}
    </form>
  );
}

function ProfileRow({ profile: p, onChanged, onError }: { profile: Profile; onChanged: () => void; onError: (m: string) => void }) {
  const [budget, setBudget] = useState(p.budget != null ? String(p.budget) : "");
  const [open, setOpen] = useState<"" | "appareils" | "mot-de-passe" | "supprimer">("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [myPassword, setMyPassword] = useState("");
  const [myCode, setMyCode] = useState("");
  const [cutError, setCutError] = useState("");
  const { withProof, proofDialog } = useProof();
  const toggle = (what: typeof open) => {
    setNotice("");
    setOpen(open === what ? "" : what);
  };
  const cutDouble = async (e: React.FormEvent) => {
    e.preventDefault();
    setCutError("");
    try {
      if (await withProof(`/api/profiles/${p.id}/double-verification/couper`, { motdepasse: myPassword, code: myCode })) {
        setCutting(false);
        onChanged();
      }
    } catch (err) {
      setCutError((err as Error).message);
      setMyCode("");
    }
  };
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
      if (await withProof(`/api/profiles/${p.id}${agents ? `?agents=${agents}` : ""}`, {}, "DELETE")) onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
    setBusy(false);
  };
  const names = p.agents.map((a) => a.name).join(", ");
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-border p-4" data-profil={p.username}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <p className="break-words text-sm font-semibold">{p.username}{p.role === "owner" && <span className="ml-2 text-xs font-medium text-muted-foreground">{t("propriétaire")}</span>}</p>
          <p className="break-words text-xs text-muted-foreground">
            {p.agents.length ? (p.agents.length > 1 ? t("{n} agents : {noms}", { n: p.agents.length, noms: names }) : t("{n} agent : {noms}", { n: p.agents.length, noms: names })) : t("Aucun agent")} · {p.appareils > 1 ? t("{n} appareils", { n: p.appareils }) : t("{n} appareil", { n: p.appareils })} · {t("{montant} $ ce mois-ci", { montant: money(p.depense) })}
          </p>
        </div>
        <Label className="flex-row items-center gap-2 text-xs font-normal text-muted-foreground">
          {t("Plafond du mois ($)")}
          <Input type="number" min={0} step={1} placeholder={t("Aucun")} className="h-8 w-24" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={saveBudget} />
        </Label>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant={open === "appareils" ? "outline" : "ghost"} aria-expanded={open === "appareils"} onClick={() => toggle("appareils")}><MonitorSmartphone />{t("Appareils")}</Button>
        {p.role !== "owner" && (
          <>
            <Button size="sm" variant={open === "mot-de-passe" ? "outline" : "ghost"} aria-expanded={open === "mot-de-passe"} onClick={() => toggle("mot-de-passe")}><KeyRound />{t("Mot de passe")}</Button>
            <Button size="sm" variant={open === "supprimer" ? "outline" : "ghost"} className="text-danger" aria-expanded={open === "supprimer"} aria-label={t("Supprimer le profil {nom}", { nom: p.username })} onClick={() => toggle("supprimer")}><Trash2 />{t("Supprimer")}</Button>
          </>
        )}
      </div>
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}
      {open === "appareils" && <ProfileDevices profile={p} onChanged={onChanged} />}
      {open === "mot-de-passe" && (
        <ResetPassword profile={p} onCancel={() => setOpen("")} onDone={() => {
          setOpen("");
          setNotice(t("Mot de passe réinitialisé. {nom} est déconnecté de tous ses appareils et devra choisir le sien à sa prochaine connexion.", { nom: p.username }));
          onChanged();
        }} />
      )}
      {p.double && p.role !== "owner" && (cutting ? (
        <form onSubmit={cutDouble} className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm">
          <p>{t("{nom} a perdu son téléphone et ses codes de secours ? Confirme avec ton mot de passe, et ton code si tu as une double vérification. Laisse-le vide sinon.", { nom: p.username })}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Label>{t("Ton mot de passe")}<Input required type="password" autoComplete="current-password" value={myPassword} onChange={(e) => setMyPassword(e.target.value)} /></Label>
            <Label>{t("Ton code")}<Input autoComplete="one-time-code" maxLength={32} className="font-mono" value={myCode} onChange={(e) => setMyCode(e.target.value)} /></Label>
          </div>
          <ErrorText>{cutError}</ErrorText>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" variant="danger">{t("Couper sa double vérification")}</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setCutting(false)}>{t("Annuler")}</Button>
          </div>
        </form>
      ) : (
        <button type="button" className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setCutting(true)}>
          {t("Double vérification activée. Couper ?")}
        </button>
      ))}
      {open === "supprimer" && (
        <div className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm">
          <p>
            {t("Supprimer {nom} coupe tout de suite ses sessions et ses appareils, et efface ses conversations sur les agents qu'on lui avait partagés.", { nom: p.username })}
            {p.agents.length > 0 && t(" Ses agents ({noms}) : à toi de choisir.", { noms: names })}
          </p>
          <div className="flex flex-wrap gap-2">
            {p.agents.length > 0 ? (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => remove("transferer")}>{t("Me transférer ses agents")}</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => remove("supprimer")}>{t("Effacer aussi ses agents et leurs fichiers")}</Button>
              </>
            ) : (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => remove()}>{t("Supprimer ce profil")}</Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("")}>{t("Annuler")}</Button>
          </div>
        </div>
      )}
      {proofDialog}
    </li>
  );
}

function NewProfile({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { withProof, proofDialog } = useProof();
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (await withProof("/api/profiles", { username: username.trim(), password, budget: budget === "" ? null : Number(budget) })) {
        setUsername("");
        setPassword("");
        setBudget("");
        onCreated();
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <form onSubmit={create} className="flex flex-col gap-3 rounded-2xl border border-dashed border-border p-4">
      <p className="text-sm font-semibold">{t("Nouveau profil")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label>{t("Nom d'utilisateur")}<Input required minLength={2} maxLength={64} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></Label>
        <Label>{t("Mot de passe initial")}<Input required type="password" minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
        <Label>{t("Plafond du mois ($)")}<Input type="number" min={0} step={1} placeholder={t("Aucun")} value={budget} onChange={(e) => setBudget(e.target.value)} /></Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("Transmets-lui ce mot de passe toi-même.")}</p>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" className="self-start" disabled={busy}><UserPlus />{t("Créer le profil")}</Button>
      {proofDialog}
    </form>
  );
}

/** Le mot de passe initial vient du propriétaire : son titulaire le remplace ici. */
export function MyPassword() {
  const [actuel, setActuel] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});
  const { withProof, proofDialog } = useProof();
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({});
    try {
      if (await withProof("/api/me/password", { actuel, nouveau })) {
        setActuel("");
        setNouveau("");
        setState({ ok: true });
      }
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };
  return (
    <form onSubmit={change} className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <p className="text-sm font-semibold">{t("Changer mon mot de passe")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label>{t("Mot de passe actuel")}<Input required type="password" autoComplete="current-password" value={actuel} onChange={(e) => setActuel(e.target.value)} /></Label>
        <Label>{t("Nouveau mot de passe")}<Input required type="password" minLength={12} autoComplete="new-password" value={nouveau} onChange={(e) => setNouveau(e.target.value)} /></Label>
      </div>
      <ErrorText>{state.error}</ErrorText>
      {state.ok && <p className="text-sm text-ok">{t("Mot de passe changé. Tes autres appareils sont déconnectés.")}</p>}
      <Button type="submit" variant="outline" className="self-start">{t("Changer")}</Button>
      {proofDialog}
    </form>
  );
}
