// Assistant de premier lancement (G1.8), dans cet ordre : code d'installation, nouvelle installation ou restauration,
// compte propriétaire, modèle, premier agent, puis un vrai échange avec le modèle. Il ne se termine qu'après la réponse.
import { lazy, Suspense, useEffect, useState } from "react";
import { type Agent, get, send, type Status, streamChat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, ErrorText, Input, Label, Textarea } from "./ui";
const ModelPicker = lazy(() => import("./ModelPicker").then((m) => ({ default: m.ModelPicker })));

type Step = "code" | "installation" | "account" | "model" | "agent" | "essai";
const STEPS: { id: Step; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "installation", label: "Installation" },
  { id: "account", label: "Compte" },
  { id: "model", label: "Modèle" },
  { id: "agent", label: "Premier agent" },
  { id: "essai", label: "Essai" },
];

/** Étape où reprendre : avant le compte au début, sinon là où l'installation s'est arrêtée (page rechargée). */
const firstStep = (st: Status): Step =>
  !st.has_account ? (st.setup_code ? "code" : "installation") : st.model_configured ? "agent" : "model";

export function Onboarding({ status, onDone }: { status: Status; onDone: () => void }) {
  const [step, setStep] = useState<Step>(() => firstStep(status));
  // VPS : le lien de fin d'installation porte le code (?installation=…).
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("installation") ?? "");
  const at = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center gap-3">
        <img src="/assets/icon.svg" alt="" className="size-9" />
        <h1 className="text-xl font-semibold">Bienvenue sur Noah Agent</h1>
      </div>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Étapes">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={i === at ? "step" : undefined}
            className={cn(i < at ? "text-muted-foreground line-through" : i === at ? "font-semibold text-foreground" : "text-muted-foreground")}>
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>
      {step === "code" && <CodeStep code={code} setCode={setCode} onNext={() => setStep("installation")} />}
      {step === "installation" && <InstallStep onNew={() => setStep("account")} />}
      {step === "account" && <AccountStep code={code} onNext={() => setStep("model")} />}
      {step === "model" && (
        <Card>
          <h2 className="text-lg font-semibold">Le cerveau de tes agents</h2>
          <p className="text-sm text-muted-foreground">
            Aucun fournisseur n'est choisi d'avance. Ollama tourne sur ton serveur : rien n'en sort. La clé d'un fournisseur
            reste chiffrée ici ; les agents ne la voient jamais. Noah n'envoie aucune télémétrie à ses développeurs.
          </p>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
            <ModelPicker first onDone={() => setStep("agent")} />
          </Suspense>
        </Card>
      )}
      {step === "agent" && <AgentStep onNext={() => setStep("essai")} />}
      {step === "essai" && <TrialStep onModel={() => setStep("model")} onDone={onDone} />}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-sm">{children}</div>;
}

function CodeStep({ code, setCode, onNext }: { code: string; setCode: (c: string) => void; onNext: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const check = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await send("/api/setup/check", { installation: value.trim() });
      history.replaceState(null, "", location.pathname); // le code ne reste pas dans l'historique
      onNext();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  // Code arrivé par le lien de fin d'installation : vérifié tout de suite.
  useEffect(() => {
    if (code) check(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <form onSubmit={(e) => { e.preventDefault(); check(code); }} className="max-w-md">
      <Card>
        <h2 className="text-lg font-semibold">Code d'installation</h2>
        <p className="text-sm text-muted-foreground">
          Il est affiché à la fin de l'installation sur le serveur. Il prouve que c'est bien toi qui as installé Noah, et non
          le premier visiteur de cette adresse.
        </p>
        <Label>
          Code
          <Input id="installation" required autoComplete="one-time-code" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
        </Label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" disabled={busy}>Continuer</Button>
      </Card>
    </form>
  );
}

function InstallStep({ onNew }: { onNew: () => void }) {
  const [restore, setRestore] = useState(false);
  return (
    <Card>
      <h2 className="text-lg font-semibold">Nouvelle installation ou restauration ?</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" onClick={onNew} className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border bg-background p-4 text-left hover:border-accent">
          <span className="font-semibold">Nouvelle installation</span>
          <span className="text-sm text-muted-foreground">Tu crées ton compte, puis ton premier agent.</span>
        </button>
        <button type="button" onClick={() => setRestore(true)} aria-expanded={restore}
          className={cn("flex cursor-pointer flex-col gap-1 rounded-xl border border-border bg-background p-4 text-left hover:border-accent", restore && "border-accent ring-1 ring-accent")}>
          <span className="font-semibold">Restaurer une sauvegarde</span>
          <span className="text-sm text-muted-foreground">Tu retrouves ton compte, tes agents, leur mémoire et l'historique.</span>
        </button>
      </div>
      {restore && (
        <div className="flex flex-col gap-2 text-sm">
          <p>Copie l'archive faite par la sauvegarde sur le serveur, puis lance dans le dossier de Noah :</p>
          <pre className="overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs">cd /opt/noah && sh scripts/restore.sh noah-AAAAMMJJ-HHMM.tar</pre>
          <p className="text-muted-foreground">Une fois terminé, recharge cette page : tu arriveras sur la connexion avec ton compte d'avant.</p>
        </div>
      )}
    </Card>
  );
}

function AccountStep({ code, onNext }: { code: string; onNext: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send("/api/setup/account", { username: username.trim(), password, installation: code.trim() });
      onNext();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="max-w-md">
      <Card>
        <h2 className="text-lg font-semibold">Ton compte</h2>
        <p className="text-sm text-muted-foreground">Le compte propriétaire. Il reste sur ce serveur.</p>
        <Label>
          Nom d'utilisateur
          <Input id="username" autoComplete="username" required minLength={2} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Label>
        <Label>
          Mot de passe
          <Input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" disabled={busy}>Créer le compte</Button>
      </Card>
    </form>
  );
}

function AgentStep({ onNext }: { onNext: () => void }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<Agent[]>("/api/agents")
      .then((list) => {
        const a = list[0] ?? null;
        setAgent(a);
        setName(a?.name ?? "Noah");
        setRole(a?.role ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!agent) await send("/api/agents", { name: name.trim(), role });
      // Inchangé : pas de reconfiguration de la machine de l'agent pour rien.
      else if (name.trim() !== agent.name || role !== agent.role) await send(`/api/agents/${agent.id}`, { name: name.trim(), role }, "PATCH");
      onNext();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="max-w-xl">
      <Card>
        <h2 className="text-lg font-semibold">Ton premier agent</h2>
        <p className="text-sm text-muted-foreground">Il a sa propre machine, avec un navigateur et ses fichiers. Tu pourras en créer d'autres ensuite.</p>
        <Label>
          Nom
          <Input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </Label>
        <Label>
          Son rôle, en quelques phrases
          <Textarea rows={4} maxLength={4000} value={role} onChange={(e) => setRole(e.target.value)} />
        </Label>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" disabled={busy || !name.trim()}>Continuer</Button>
      </Card>
    </form>
  );
}

const READY_WAIT = 180_000; // première création de la machine d'un agent : image à télécharger sur un VPS neuf

function TrialStep({ onModel, onDone }: { onModel: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<"waiting" | "asking" | "ok" | "error">("waiting");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stop = false;
    (async () => {
      setPhase("waiting");
      setReply("");
      setError("");
      try {
        const until = Date.now() + READY_WAIT;
        let agent: Agent | undefined;
        while (!stop && Date.now() < until) {
          agent = (await get<Agent[]>("/api/agents"))[0];
          if (agent?.online) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (stop) return;
        if (!agent?.online) throw new Error("L'agent n'a pas démarré à temps. Vérifie que Docker tourne sur le serveur, puis réessaie.");
        setPhase("asking");
        let text = "";
        let failure = "";
        await streamChat(
          { agent_id: agent.id, text: "Bonjour ! Présente-toi en une phrase.", conversation_id: null, attachments: [], details: false },
          (ev) => {
            if (ev.type === "message") setReply((text += ev.text));
            if (ev.type === "done") {
              if (ev.status && ev.status !== "completed") failure = ev.error || `Échec : ${ev.status}`;
              else if (!text && ev.output) setReply((text = ev.output));
            }
          },
        );
        if (stop) return;
        if (failure || !text.trim()) throw new Error(failure || "Le modèle n'a rien répondu.");
        await send("/api/setup/done", {});
        setPhase("ok");
      } catch (e) {
        if (!stop) {
          setError((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [attempt]);
  return (
    <Card>
      <h2 className="text-lg font-semibold">Premier essai</h2>
      <p className="text-sm text-muted-foreground">On vérifie de bout en bout que ton agent répond, avec ta clé et ton modèle.</p>
      {phase === "waiting" && <p className="text-sm">Démarrage de la machine de l'agent… (jusqu'à trois minutes la première fois)</p>}
      {phase === "asking" && <p className="text-sm">L'agent réfléchit…</p>}
      {reply && <blockquote className="rounded-lg border-l-4 border-accent bg-background p-3 text-sm">{reply}</blockquote>}
      <ErrorText>{error}</ErrorText>
      {phase === "error" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAttempt((n) => n + 1)}>Réessayer</Button>
          <Button variant="outline" onClick={onModel}>Changer de modèle ou de clé</Button>
        </div>
      )}
      {phase === "ok" && <Button size="lg" onClick={onDone}>Commencer</Button>}
    </Card>
  );
}
