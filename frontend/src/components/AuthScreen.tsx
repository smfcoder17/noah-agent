import { useState } from "react";
import { send } from "@/lib/api";
import { appShell } from "@/lib/platform";
import { Button, ErrorText, Input, Label } from "./ui";

const box = "flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-sm";

/**
 * Mot de passe oublié, sans courriel : le propriétaire prouve qu'il a la main sur le serveur en y lisant un code.
 * Le bouton écrit le code dans les journaux du serveur, jamais dans la réponse (server/noah/recuperation.py).
 */
function ForgotPassword({ onBack, onChanged }: { onBack: () => void; onChanged: (username: string) => void }) {
  const [asked, setAsked] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setError("");
    try {
      await send("/api/recuperation/code", {});
      setAsked(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("Les deux mots de passe ne sont pas identiques.");
    setBusy(true);
    setError("");
    try {
      const r = await send<{ username: string }>("/api/recuperation", { code: code.trim(), password });
      onChanged(r.username);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={`${box} max-w-md`}>
      <h1 className="text-xl font-semibold">Mot de passe oublié</h1>
      <p className="text-sm text-muted-foreground">
        Noah n'envoie pas de courriel. Pour prouver que ce serveur est à toi, tu lis un code sur le serveur lui-même. Il sert une
        seule fois, pendant 15 minutes. Cette page change le mot de passe du propriétaire.
      </p>

      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">1. Crée le code</p>
        <Button type="button" variant="outline" onClick={ask}>{asked ? "Créer un code (déjà demandé)" : "Créer un code"}</Button>
        {asked && <p role="status" className="text-muted-foreground">C'est fait. S'il y avait déjà un code en cours, il reste valable : prends le dernier affiché.</p>}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">2. Lis-le sur le serveur</p>
        <p className="text-muted-foreground">
          <b className="text-foreground">Sur Hostinger :</b> ouvre ton VPS (Manage), puis Docker Manager → Projects. En face de ton
          projet, ouvre le menu ⋮ puis View logs. Cherche « Code de récupération » : ce sont trois groupes de quatre lettres.
        </p>
        <p className="text-muted-foreground">
          <b className="text-foreground">Avec un terminal sur le serveur :</b> cette commande crée un nouveau code et l'affiche.
        </p>
        <code className="overflow-x-auto rounded-lg bg-muted px-2 py-1.5 text-xs whitespace-nowrap">docker exec noah-server python -m noah.recuperation</code>
      </div>

      <div className="flex flex-col gap-3 text-sm">
        <p className="font-medium">3. Choisis un nouveau mot de passe</p>
        <Label>
          Code de récupération
          <Input id="recovery-code" autoComplete="one-time-code" placeholder="BCDF-GHJK-LMNP" required value={code} onChange={(e) => setCode(e.target.value)} />
        </Label>
        <Label>
          Nouveau mot de passe
          <Input id="new-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        <Label>
          Encore une fois
          <Input id="new-password-again" type="password" autoComplete="new-password" required minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} />
        </Label>
        <p className="text-muted-foreground">Toutes les sessions du serveur seront fermées, sur tous les appareils et tous les profils. Il faudra relier tes applications de nouveau. Tes agents continuent de tourner.</p>
      </div>

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>Retour</Button>
        <Button type="submit" disabled={busy}>Changer le mot de passe</Button>
      </div>
    </form>
  );
}

// Connexion. La création du compte propriétaire est une étape de l'assistant de premier lancement (Onboarding).
export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [changed, setChanged] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send("/api/login", { username: username.trim(), password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  // Dans une app (bureau, téléphone), le mot de passe ne se tape pas : l'appareil se relie de nouveau.
  const shell = appShell();
  if (shell)
    return (
      <div className="grid min-h-full place-items-center px-4 py-10">
        <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-sm">
          <img src="/assets/icon.svg" alt="" className="size-11" />
          <h1 className="text-xl font-semibold">Cet appareil n'est plus relié</h1>
          <p className="text-sm text-muted-foreground">
            Il a été déconnecté depuis Réglages → Appareils, ou n'a pas servi depuis longtemps. Relie-le de nouveau : ça prend
            quelques secondes.
          </p>
          <Button size="lg" onClick={() => shell.forget()}>Relier de nouveau</Button>
        </div>
      </div>
    );

  if (forgot)
    return (
      <div className="grid min-h-full place-items-center px-4 py-10">
        <ForgotPassword
          onBack={() => setForgot(false)}
          onChanged={(name) => {
            setUsername(name);
            setPassword("");
            setError("");
            setChanged(true);
            setForgot(false);
          }}
        />
      </div>
    );

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <form onSubmit={submit} className={box}>
        <img src="/assets/icon.svg" alt="" className="size-11" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Connexion à Noah Agent</h1>
        </div>
        {changed && <p role="status" className="text-sm text-muted-foreground">Mot de passe changé. Connecte-toi avec le nouveau. Ton nom d'utilisateur est déjà rempli.</p>}
        <Label>
          Nom d'utilisateur
          <Input id="username" autoComplete="username" required minLength={2} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Label>
        <Label>
          Mot de passe
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" disabled={busy}>Se connecter</Button>
        <button type="button" className="self-center text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => { setError(""); setForgot(true); }}>
          Mot de passe oublié ?
        </button>
      </form>
    </div>
  );
}
