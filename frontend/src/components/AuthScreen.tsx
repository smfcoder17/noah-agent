import { useState } from "react";
import { send } from "@/lib/api";
import { appShell } from "@/lib/platform";
import { Button, ErrorText, Input, Label } from "./ui";

// Connexion. La création du compte propriétaire est une étape de l'assistant de premier lancement (Onboarding).
export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-sm">
        <img src="/assets/icon.svg" alt="" className="size-11" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Connexion à Noah Agent</h1>
        </div>
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
      </form>
    </div>
  );
}
