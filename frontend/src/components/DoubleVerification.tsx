// Réglages > Sécurité : la double vérification de ce compte. Activer demande le mot de passe, puis un premier code ; les codes
// de secours ne se montrent qu'une fois. Couper demande le mot de passe et un code (server/noah/double_verification.py).
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { QR } from "./PhonePairing";
import { useProof } from "./Proof";
import { Button, ErrorText, Input, Label } from "./ui";

type Status = { active: boolean; secours: number };
type Setup = { secret: string; adresse: string };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      /* presse-papiers refusé (page sans HTTPS) : le texte reste à l'écran, à sélectionner */
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" className="self-start" onClick={copy}>
      {done ? <Check /> : <Copy />}{done ? "Copié" : label}
    </Button>
  );
}

/** Mot de passe seul : le début de l'activation. */
function Start({ onReady, onCancel }: { onReady: (s: Setup) => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onReady(await send<Setup>("/api/me/double-verification/preparer", { motdepasse: password }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Label className="max-w-xs">
        Ton mot de passe
        <Input id="double-password" required type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Label>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Continuer</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/** QR code et secret, puis le premier code qui prouve que l'application les a bien enregistrés. */
function Confirm({ setup, onDone, onCancel }: { setup: Setup; onDone: (codes: string[]) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone((await send<{ secours: string[] }>("/api/me/double-verification/confirmer", { code })).secours);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <QR text={setup.adresse} />
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p className="font-medium">1. Ajoute Noah à ton application de codes</p>
          <p className="text-muted-foreground">Google Authenticator, Aegis, 1Password ou une autre : scanne ce QR code. Si tu ne peux pas le scanner, saisis cette clé à la main.</p>
          <p id="double-secret" className="break-all rounded-lg bg-muted px-2 py-1.5 font-mono text-xs">{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
          <CopyButton text={setup.secret} label="Copier la clé" />
        </div>
      </div>
      <p className="text-sm font-medium">2. Recopie le code à 6 chiffres qu'elle affiche</p>
      <Label className="max-w-40">
        Code
        <Input id="double-first-code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
      </Label>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Activer</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/** Les codes de secours : leur seul affichage. */
function SpareCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        Note ces 8 codes maintenant, hors de ce téléphone : tu ne les reverras plus. Chacun remplace une fois le code de l'application si tu perds ton téléphone.
      </p>
      <ul id="double-spare" className="grid gap-1 rounded-lg bg-muted p-3 font-mono text-sm sm:grid-cols-2">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={codes.join("\n")} label="Copier les codes" />
        <Button size="sm" onClick={onDone}>Je les ai notés</Button>
      </div>
    </div>
  );
}

/** Couper : mot de passe et code. */
function CutForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { withProof, proofDialog } = useProof();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (await withProof("/api/me/double-verification/couper", { motdepasse: password, code })) onDone();
      else setBusy(false);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label>Ton mot de passe<Input id="double-cut-password" required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
        <Label>Code de l'application ou code de secours<Input id="double-cut-code" required autoComplete="one-time-code" maxLength={32} className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} /></Label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={busy}>Désactiver</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
      {proofDialog}
    </form>
  );
}

export function DoubleVerification() {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<"idle" | "start" | "cut">("idle");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const load = useCallback(() => get<Status>("/api/me/double-verification").then(setStatus).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  const reset = () => {
    setStep("idle");
    setSetup(null);
    setCodes(null);
    load();
  };
  if (!status) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className={`mt-0.5 size-4 shrink-0 ${status.active ? "text-ok" : "text-muted-foreground"}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Double vérification{status.active && <span className="ml-2 text-xs font-medium text-ok">activée</span>}</p>
          <p className="text-xs text-muted-foreground">
            {status.active
              ? `À la connexion, Noah demande aussi le code de ton application. Il te reste ${status.secours} code${status.secours > 1 ? "s" : ""} de secours. Tes appareils déjà reliés restent connectés.`
              : "En plus du mot de passe, Noah demandera un code à 6 chiffres donné par une application sur ton téléphone. Un mot de passe volé ne suffira plus à se connecter."}
          </p>
        </div>
      </div>
      {codes ? (
        <SpareCodes codes={codes} onDone={reset} />
      ) : setup ? (
        <Confirm setup={setup} onDone={setCodes} onCancel={reset} />
      ) : step === "start" ? (
        <Start onReady={setSetup} onCancel={reset} />
      ) : step === "cut" ? (
        <CutForm onDone={reset} onCancel={reset} />
      ) : status.active ? (
        <Button variant="ghost" size="sm" className="self-start text-danger" onClick={() => setStep("cut")}>Désactiver la double vérification</Button>
      ) : (
        <Button variant="outline" className="self-start" onClick={() => setStep("start")}>Activer la double vérification</Button>
      )}
    </div>
  );
}
