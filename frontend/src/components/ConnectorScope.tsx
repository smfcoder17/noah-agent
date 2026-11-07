// « Pour cet agent / Pour tous mes agents » sur une connexion établie, puis la liste à cocher. Le serveur (connecteurs.py) choisit la voie la plus sûre pour chaque service.
import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { appLabel } from "@/lib/appLabel";
import { cn } from "@/lib/utils";
import { type Droit, LoginAuto, LoginBack, RightSelect } from "./AgentPowers";
import { Button, ErrorText } from "./ui";

type ScopeAgent = { id: string; nom: string; coche: boolean; etat: "ok" | "a_connecter" | "en_attente" | "exclu" | "partage" | "arrete"; origine: boolean; invites: string[]; droit: Droit | null };
type ScopeState = { nom: string; pour_tous: boolean; genre: string; voie: string; agents: ScopeAgent[]; soucis?: Record<string, string> };
type Waiting = Record<string, "auto" | "coller">;

/** Ce connecteur attend le clic de cet agent : la ligne de l'onglet Connexions, sur l'agent concerné. */
export function PendingGlobal({ agentId, nom, waiting, onWait, onChange, onError }: { agentId: string; nom: string; waiting?: "auto" | "coller"; onWait: (mode?: "auto" | "coller") => void; onChange: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const label = appLabel(nom);
  const connect = async () => {
    setBusy(true);
    onError("");
    try {
      const r = await send<{ adresse?: string; retour?: boolean }>(`/api/agents/${agentId}/connecteurs/${nom}/connecter`, {});
      if (r.adresse) {
        window.open(r.adresse, "_blank", "noopener");
        onWait(r.retour ? "auto" : "coller");
      }
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">Pour tous tes agents. Un clic pour le relier à celui-ci.</p>
        </div>
        {!waiting && <Button size="sm" onClick={connect} disabled={busy}>{busy && <Loader2 className="animate-spin" />}Connecter</Button>}
      </div>
      {waiting === "auto" && <LoginAuto onReopen={connect} busy={busy} />}
    </div>
  );
}

export function ConnectorScope({ agentId, nom, global, onChange }: { agentId: string; nom: string; /** Déjà pour tous : l'état lu avec les connexions. */ global: boolean; onChange: () => void }) {
  const [view, setView] = useState<ScopeState | null>(null);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState<Waiting>({});
  const [back, setBack] = useState("");
  const label = appLabel(nom);
  const path = `/api/agents/${agentId}/connecteurs/${nom}`;
  const read = useCallback(async () => {
    const v = await get<ScopeState>(path);
    setView(v);
    setWaiting((w) => Object.fromEntries(Object.entries(w).filter(([id]) => v.agents.find((a) => a.id === id)?.etat === "a_connecter")));
    return v;
  }, [path]);
  const reveal = async () => {
    setOpen(true);
    setError("");
    try {
      const v = await read();
      setTicked(v.agents.filter((a) => a.coche).map((a) => a.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const automatic = Object.values(waiting).includes("auto");
  useEffect(() => { // le fournisseur revient directement sur le serveur : on relit jusqu'à voir l'agent relié
    if (!automatic) return;
    const again = setInterval(() => void read().catch(() => {}), 4000);
    return () => clearInterval(again);
  }, [automatic, read]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = () => run(async () => {
    const v = await send<ScopeState>(path, { pour_tous: true, agents: ticked }, "PUT");
    setView(v);
    setTicked(v.agents.filter((a) => a.coche).map((a) => a.id));
    const trouble = Object.entries(v.soucis ?? {}).map(([id, why]) => `${v.agents.find((a) => a.id === id)?.nom ?? "Un agent"} : ${why}`);
    setError(trouble.join(" "));
    onChange();
  });
  const onlyHere = () => {
    if (!global) return setOpen(false);
    if (!confirm(`Garder ${label} pour cet agent seulement ? Les autres n'y auront plus accès.`)) return;
    run(async () => {
      await send(path, { pour_tous: false }, "PUT");
      setOpen(false);
      setView(null);
      onChange();
    });
  };
  const connect = (a: ScopeAgent) => run(async () => {
    const r = await send<{ adresse?: string; retour?: boolean }>(`/api/agents/${a.id}/connecteurs/${nom}/connecter`, {});
    if (r.adresse) {
      window.open(r.adresse, "_blank", "noopener");
      setWaiting((w) => ({ ...w, [a.id]: r.retour ? "auto" : "coller" }));
    }
    await read();
  });
  const finish = (a: ScopeAgent) => run(async () => {
    const kind = view?.genre === "appli" ? "apps" : "tools";
    await send(`/api/agents/${a.id}/connections/${kind}/${nom}/finish`, { adresse: back });
    setBack("");
    setWaiting((w) => Object.fromEntries(Object.entries(w).filter(([id]) => id !== a.id)));
    await read();
  });

  const changed = !!view && !!ticked && (!view.pour_tous || view.agents.some((a) => a.coche !== ticked.includes(a.id)));
  const choice = "h-8 flex-1 cursor-pointer rounded-md px-2 text-xs font-medium transition-colors";
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={`Qui a ${label}`} className="flex rounded-lg bg-muted p-0.5">
        <button type="button" role="radio" aria-checked={!global && !open} onClick={onlyHere} disabled={busy}
          className={cn(choice, !global && !open ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>Pour cet agent</button>
        <button type="button" role="radio" aria-checked={global || open} onClick={() => (open && !changed ? setOpen(false) : void reveal())} disabled={busy}
          className={cn(choice, global || open ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>Pour tous mes agents</button>
      </div>
      {open && !view && !error && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Lecture…</p>}
      {open && view && ticked && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{view.voie}</p>
          <ul className="flex flex-col gap-1" aria-label={`Agents qui ont ${label}`}>
            {view.agents.map((a) => {
              const on = ticked.includes(a.id);
              return (
                <li key={a.id} className="flex flex-col gap-1 rounded-lg bg-muted/50 px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <label className="flex min-w-0 flex-1 basis-32 cursor-pointer items-center gap-2 text-sm">
                      <input type="checkbox" checked={on} className="size-4 shrink-0 accent-[var(--accent)]"
                        onChange={(e) => setTicked((t) => (e.target.checked ? [...(t ?? []), a.id] : (t ?? []).filter((id) => id !== a.id)))} />
                      <span className="truncate">{a.nom}</span>
                    </label>
                    {view.pour_tous && a.coche && a.etat === "ok" && <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />Connecté</span>}
                    {view.pour_tous && a.coche && a.etat === "arrete" && <span className="text-xs text-muted-foreground">Agent arrêté</span>}
                    {view.pour_tous && a.coche && a.etat === "en_attente" && <span className="text-xs text-muted-foreground">Arrive à son démarrage</span>}
                    {view.pour_tous && a.coche && a.etat === "a_connecter" && !waiting[a.id] && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => connect(a)} disabled={busy}>Connecter</Button>
                    )}
                    {a.droit && a.coche && <RightSelect agentId={a.id} name={nom} droit={a.droit} onChange={() => void read().catch(() => {})} onError={setError} />}
                  </div>
                  {a.invites.length > 0 && !on && <p className="text-xs font-medium text-warn">Partagé avec {a.invites.join(", ")}, qui aurait aussi accès à ce compte : coche seulement si tu le veux.</p>}
                  {a.invites.length > 0 && on && <p className="text-xs text-muted-foreground">{a.invites.join(", ")} a aussi accès à ce compte par cet agent.</p>}
                  {waiting[a.id] === "auto" && <LoginAuto onReopen={() => connect(a)} busy={busy} />}
                  {waiting[a.id] === "coller" && <LoginBack label={label} value={back} onValue={setBack} onReopen={() => connect(a)} onFinish={() => finish(a)} busy={busy} />}
                </li>
              );
            })}
          </ul>
          {!view.pour_tous && <p className="text-xs text-muted-foreground">Tes prochains agents l'auront aussi. Chacun garde son droit : il demande confirmation tant que tu ne changes rien.</p>}
          {changed && (
            <Button size="sm" className="self-end" onClick={apply} disabled={busy || !ticked.length}>
              {busy && <Loader2 className="animate-spin" />}{view.pour_tous ? "Enregistrer" : "Mettre pour ces agents"}
            </Button>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
