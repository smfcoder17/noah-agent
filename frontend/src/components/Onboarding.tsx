// Assistant de premier lancement (G1.8), dans cet ordre : code d'installation, nouvelle installation ou restauration,
// compte propriétaire, modèle, premier agent, puis un vrai échange avec le modèle. Il ne se termine qu'après la réponse.
import { lazy, Suspense, useEffect, useState } from "react";
import { type Agent, ApiError, get, request, send, type Status, streamChat } from "@/lib/api";
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

// Code vérifié, gardé pour cet onglet : une page rechargée avant la création du compte ne le redemande pas.
const CODE_KEY = "noah-installation";
const savedCode = () => {
  try {
    return sessionStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Étape où reprendre : avant le compte au début, sinon là où l'installation s'est arrêtée (page rechargée). */
const firstStep = (st: Status): Step =>
  !st.has_account ? (st.setup_code && !savedCode() ? "code" : "installation") : st.model_configured ? "agent" : "model";

export function Onboarding({ status, onDone }: { status: Status; onDone: () => void }) {
  const [step, setStep] = useState<Step>(() => firstStep(status));
  // VPS : le lien de fin d'installation porte le code dans le # (#installation=…), qui ne part ni vers le serveur ni dans les
  // journaux d'accès. Les liens d'avant (?installation=…) restent lus.
  const [code, setCode] = useState(() =>
    new URLSearchParams(location.hash.slice(1)).get("installation") ?? new URLSearchParams(location.search).get("installation") ?? savedCode());
  const [agentId, setAgentId] = useState<string | null>(null);
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
      {step === "installation" && <InstallStep code={code} onNew={() => setStep("account")} />}
      {step === "account" && <AccountStep code={code} onNext={() => setStep("model")} onBadCode={() => { setCode(""); setStep("code"); }} />}
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
      {step === "agent" && <AgentStep onNext={(id) => { setAgentId(id); setStep("essai"); }} />}
      {step === "essai" && <TrialStep agentId={agentId} onModel={() => setStep("model")} onDone={onDone} />}
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
      await send("/api/setup/check", { installation: value.trim() }).catch((e) => {
        if (e instanceof ApiError && e.status === 410) location.reload(); // compte créé ailleurs entre-temps
        throw e;
      });
      history.replaceState(null, "", location.pathname); // le code ne reste pas dans l'historique
      try {
        sessionStorage.setItem(CODE_KEY, value.trim());
      } catch {
        /* stockage bloqué : un rechargement redemandera le code */
      }
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

function InstallStep({ code, onNew }: { code: string; onNew: () => void }) {
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
      {restore && <Restore code={code} />}
    </Card>
  );
}

type RestoreState = { etape: string | null; erreur: string | null; fini: boolean; avertissement?: string | null };

/** Envoi de l'archive de scripts/backup.sh, puis suivi : le serveur redémarre en cours de route (G3.5). */
function Restore({ code }: { code: string }) {
  const [sent, setSent] = useState<number | null>(null); // pourcentage envoyé
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); // restauré, avec quelque chose à refaire (dossiers partagés)
  const upload = (file: File) => {
    setError("");
    setSent(0);
    // XMLHttpRequest : fetch ne donne pas l'avancement d'un envoi, et l'archive peut peser des gigaoctets.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/setup/restore");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Noah-Installation", code.trim());
    xhr.upload.onprogress = (e) => e.lengthComputable && setSent(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status === 200) return follow();
      let detail = `Erreur ${xhr.status}`;
      try {
        detail = JSON.parse(xhr.responseText).detail || detail;
      } catch {
        /* corps non JSON */
      }
      setError(detail);
      setSent(null);
    };
    xhr.onerror = () => {
      setError("Envoi interrompu. Vérifie ta connexion, puis recommence.");
      setSent(null);
    };
    xhr.send(file);
  };
  const follow = async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st: RestoreState | null = await get<RestoreState>("/api/setup/restore").catch(() => null);
      if (!st) {
        setStage("Redémarrage du serveur…");
        continue;
      }
      if (st.erreur) {
        setError(`Restauration impossible : ${st.erreur}`);
        setSent(null);
        return;
      }
      setStage(st.etape ?? "");
      if (st.fini) {
        try {
          sessionStorage.removeItem(CODE_KEY);
        } catch {
          /* rien à effacer */
        }
        if (st.avertissement) return setNotice(st.avertissement);
        return location.reload(); // compte de la sauvegarde : écran de connexion
      }
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Choisis l'archive faite par la sauvegarde (<code className="font-mono text-xs">noah-AAAAMMJJ-HHMM.tar</code>, dans le
        dossier <code className="font-mono text-xs">backups</code> de ton ancienne installation). Les agents, leur mémoire,
        tes conversations et tes réglages reviennent ; tu te connectes ensuite avec ton compte d'avant.
      </p>
      {sent === null ? (
        <input type="file" accept=".tar,application/x-tar" aria-label="Archive de sauvegarde"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          className="text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5" />
      ) : (
        !notice && <p>{sent < 100 ? `Envoi de l'archive : ${sent} %` : stage || "Vérification de l'archive…"}</p>
      )}
      <ErrorText>{error}</ErrorText>
      {notice && (
        <>
          <p>Restauré. {notice}</p>
          <Button onClick={() => location.reload()}>Se connecter</Button>
        </>
      )}
    </div>
  );
}

function AccountStep({ code, onNext, onBadCode }: { code: string; onNext: () => void; onBadCode: () => void }) {
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
      try {
        sessionStorage.removeItem(CODE_KEY);
      } catch {
        /* rien à effacer */
      }
      onNext();
    } catch (err) {
      // Compte déjà créé (autre onglet, réponse perdue) : on repart de l'état du serveur (connexion ou suite).
      if (err instanceof ApiError && err.status === 410) return location.reload();
      // Code gardé pour l'onglet mais refusé (changé au redémarrage du serveur) : on le redemande.
      if (err instanceof ApiError && err.status === 403 && code) {
        try {
          sessionStorage.removeItem(CODE_KEY);
        } catch {
          /* rien à effacer */
        }
        return onBadCode();
      }
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

function AgentStep({ onNext }: { onNext: (agentId: string) => void }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loaded, setLoaded] = useState(false); // tant que la liste n'est pas lue, « aucun agent » n'est pas sûr
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
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!agent) return onNext((await send<{ id: string }>("/api/agents", { name: name.trim(), role })).id);
      // Inchangé : pas de reconfiguration de la machine de l'agent pour rien.
      if (name.trim() !== agent.name || role !== agent.role) await send(`/api/agents/${agent.id}`, { name: name.trim(), role }, "PATCH");
      onNext(agent.id);
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
        <Button type="submit" size="lg" disabled={busy || !loaded || !name.trim()}>Continuer</Button>
      </Card>
    </form>
  );
}

/** Délai par requête, et abandon si l'étape est quittée. */
const bounded = (stop: AbortSignal) =>
  AbortSignal.any ? AbortSignal.any([stop, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);

const READY_WAIT = 180_000; // première création de la machine d'un agent : image à télécharger sur un VPS neuf
const ANSWER_WAIT = 180_000; // réponse du modèle : au-delà, on rend la main plutôt que d'attendre sans fin

function TrialStep({ agentId, onModel, onDone }: { agentId: string | null; onModel: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<"waiting" | "asking" | "ok" | "error">("waiting");
  const [step, setStep] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [agent, setAgent] = useState<Agent | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    (async () => {
      setPhase("waiting");
      setReply("");
      setError("");
      try {
        const until = Date.now() + READY_WAIT;
        let a: Agent | undefined;
        while (!stop.signal.aborted && Date.now() < until) {
          const list: Agent[] = await (await request("/api/agents", { signal: bounded(stop.signal) })).json();
          a = list.find((x) => x.id === agentId) ?? list[0];
          setAgent(a ?? null);
          setStep(a?.step ?? "");
          if (a?.online) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (stop.signal.aborted) return;
        if (!a?.online) throw new Error("L'agent n'a pas démarré à temps. Vérifie que Docker tourne sur le serveur, puis répare l'agent.");
        setPhase("asking");
        let text = "";
        let status = "";
        let failure = "";
        let runId = "";
        const timer = setTimeout(() => {
          stop.abort("délai");
          // Le serveur poursuit une exécution dont le flux est coupé : on l'arrête, sinon elle consomme encore.
          if (runId) send(`/api/agents/${a!.id}/runs/${runId}/stop`, {}).catch(() => {});
        }, ANSWER_WAIT);
        try {
          await streamChat(
            { agent_id: a.id, text: "Bonjour ! Présente-toi en une phrase.", conversation_id: null, attachments: [], details: false },
            (ev) => {
              if (ev.type === "start") runId = ev.run_id;
              if (ev.type === "message") setReply((text += ev.text));
              if (ev.type === "done") {
                status = ev.status;
                failure = ev.error || "";
                if (!text && ev.output) setReply((text = ev.output));
              }
            },
            stop.signal,
          );
        } finally {
          clearTimeout(timer);
          // Flux coupé, étape quittée ou erreur avant la fin : l'exécution continuerait côté serveur, on l'arrête.
          // (À l'échéance, le minuteur l'a déjà demandé.)
          if (runId && status !== "completed" && stop.signal.reason !== "délai")
            send(`/api/agents/${a.id}/runs/${runId}/stop`, {}).catch(() => {});
        }
        if (stop.signal.reason === "délai") throw new Error("Le modèle n'a pas répondu en trois minutes.");
        if (stop.signal.aborted) return;
        // Seule une exécution terminée compte : un texte suivi d'une erreur, ou un flux coupé, n'est pas une réponse.
        if (status !== "completed" || !text.trim()) throw new Error(failure || "Le modèle n'a pas répondu jusqu'au bout.");
        await request("/api/setup/done", { method: "POST", body: "{}", signal: bounded(stop.signal) });
        setPhase("ok");
      } catch (e) {
        if (stop.signal.reason === "délai" || !stop.signal.aborted) {
          setError(stop.signal.reason === "délai" ? "Le modèle n'a pas répondu en trois minutes." : (e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => stop.abort();
  }, [attempt, agentId]);
  // Machine de l'agent arrêtée, absente ou restée en erreur : le serveur la redémarre (ou la recrée) puis la configure.
  const repair = async () => {
    if (!agent) return;
    try {
      await send(`/api/agents/${agent.id}/repair`, {});
      setAttempt((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card>
      <h2 className="text-lg font-semibold">Premier essai</h2>
      <p className="text-sm text-muted-foreground">On vérifie de bout en bout que ton agent répond, avec ta clé et ton modèle.</p>
      {phase === "waiting" && <p className="text-sm">{step || "Démarrage de la machine de l'agent…"} (jusqu'à trois minutes la première fois)</p>}
      {phase === "asking" && <p className="text-sm">L'agent réfléchit…</p>}
      {reply && <blockquote className="rounded-lg border-l-4 border-accent bg-background p-3 text-sm">{reply}</blockquote>}
      <ErrorText>{error}</ErrorText>
      {phase === "error" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAttempt((n) => n + 1)}>Réessayer</Button>
          {agent && <Button variant="outline" onClick={repair}>Réparer l'agent</Button>}
          <Button variant="outline" onClick={onModel}>Changer de modèle ou de clé</Button>
        </div>
      )}
      {phase === "ok" && <Button size="lg" onClick={onDone}>Commencer</Button>}
    </Card>
  );
}
