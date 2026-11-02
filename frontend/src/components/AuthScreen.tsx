import { useEffect, useState } from "react";
import { get, send, type Status } from "@/lib/api";
import { Button, ErrorText, Input, Label } from "./ui";

export function AuthScreen({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // VPS : le lien de fin d'installation porte le code (?installation=…) ; sinon on le demande.
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("installation") ?? "");
  const [codeFromLink] = useState(() => !!new URLSearchParams(location.search).get("installation"));
  const [needsCode, setNeedsCode] = useState(false);
  useEffect(() => {
    if (codeFromLink) history.replaceState(null, "", location.pathname);
    if (mode === "setup") get<Status>("/api/status").then((st) => setNeedsCode(!!st.setup_code)).catch(() => {});
  }, [mode, codeFromLink]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send(mode === "setup" ? "/api/setup/account" : "/api/login", { username: username.trim(), password, installation: code.trim() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-sm">
        <img src="/assets/icon.svg" alt="" className="size-11" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{mode === "setup" ? "Bienvenue sur Noah Agent" : "Connexion à Noah Agent"}</h1>
          {mode === "setup" && <p className="text-sm text-muted-foreground">Crée le compte administrateur. Il reste sur cette machine.</p>}
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
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            required
            minLength={mode === "setup" ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Label>
        {mode === "setup" && needsCode && !codeFromLink && (
          <Label>
            Code d'installation
            <Input id="installation" required autoComplete="one-time-code" placeholder="Affiché à la fin de l'installation" value={code} onChange={(e) => setCode(e.target.value)} />
          </Label>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" disabled={busy}>{mode === "setup" ? "Créer le compte" : "Se connecter"}</Button>
      </form>
    </div>
  );
}
