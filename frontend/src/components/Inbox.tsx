import { subscribeUpdates } from "@/lib/events";
// « À toi » : tout ce qui attend la personne, tous agents confondus. Un accord se donne ici ; le reste ouvre la conversation.
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Agent, get, type InboxItem, send } from "@/lib/api";
import { refreshAccords, useAccords } from "@/lib/events";
import { LoginCard } from "./LoginCard";
import { AgentFace } from "./Noah";
import { StateShape } from "./Sidebar";
import { Button, Dialog, DialogContent, ErrorText } from "./ui";

export function Inbox({ open, agents, onOpenChange, onOpenConversation }: {
  open: boolean;
  agents: Agent[];
  onOpenChange: (open: boolean) => void;
  onOpenConversation: (item: InboxItem) => void;
}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const { items: accords } = useAccords();
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError("");
    const load = () => get<InboxItem[]>("/api/a-toi").then((rows) => setItems(rows.filter((r) => !r.request_id))).catch((e) => setError((e as Error).message));
    void load();
    // Connexions et choix gardent leur relève existante ; les accords viennent exclusivement du bus et de /api/accords (secours 60 s).
    const timer = subscribeUpdates(load);
    return () => timer();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false); // l'écran du navigateur s'ouvre derrière cette fenêtre
    window.addEventListener("noah:voir-ecran", close);
    return () => window.removeEventListener("noah:voir-ecran", close);
  }, [open, onOpenChange]);
  const answer = async (item: InboxItem, approve: boolean) => {
    setBusy(item.id ?? item.conversation_id);
    setError("");
    try {
      await send(`/api/agents/${item.agent_id}/runs/${item.run_id}/approval`, { request_id: item.request_id, generation: item.generation, approve });
      setItems((cur) => cur?.filter((i) => i.request_id !== item.request_id) ?? null); // un accord suivant reste à donner
      void refreshAccords();
      window.dispatchEvent(new CustomEvent("noah:accord-repondu", { detail: { request_id: item.request_id, result: approve ? "approved" : "denied" } }));
    } catch (e) {
      void refreshAccords().catch(() => {});
      setError(`La réponse n'a pas été prise en compte : ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="À toi" description="Ce que tes agents attendent de toi." className="max-w-lg">
          <ErrorText>{error}</ErrorText>
          {!items && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
          {items?.length === 0 && !accords.length && <p className="py-4 text-sm text-muted-foreground">Rien ne t'attend pour le moment.</p>}
          <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto max-md:max-h-none max-md:overflow-visible">
            {[...accords, ...(items ?? [])].sort((a, b) => a.created - b.created).map((item) => {
              const agent = agents.find((a) => a.id === item.agent_id);
              return (
                <li key={item.id ?? item.conversation_id} className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
                  <button type="button" onClick={() => onOpenConversation(item)} className="flex w-full cursor-pointer items-start gap-3 text-left" aria-label={`Ouvrir la conversation : ${item.demande}`}>
                    {agent && <AgentFace agent={agent} className="size-9 shrink-0" />}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-warn">
                        <StateShape state={item.etat} />
                        {item.connexion ? "Attend ta connexion" : item.etat === "approve" ? "Attend ton accord" : "Attend ton choix"}
                      </span>
                      <span className="text-sm font-medium">{item.demande}</span>
                      {item.pourquoi && <span className="text-xs text-muted-foreground">{item.pourquoi}</span>}
                      {item.apercu.map((line) => <span key={line} className="truncate text-xs text-muted-foreground">« {line} »</span>)}
                      <span className="truncate text-xs text-muted-foreground">{item.agent}{item.main ? "" : ` · ${item.titre}`}</span>
                    </span>
                  </button>
                  {item.connexion && (
                    <LoginCard
                      agentId={item.agent_id}
                      asked={item.connexion}
                      onDone={(result) => {
                        setItems((cur) => cur?.filter((i) => i.conversation_id !== item.conversation_id) ?? null);
                        window.dispatchEvent(new CustomEvent("noah:connexion-repondue", { detail: { id: item.connexion?.id, result } }));
                        window.dispatchEvent(new Event("noah:accord-repondu"));
                      }}
                    />
                  )}
                  {item.bureau ? <p className="text-sm text-muted-foreground">À accepter sur ton ordinateur</p> : item.etat === "approve" && item.run_id && (
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" disabled={busy === item.id} onClick={() => answer(item, false)}>Refuser</Button>
                      <Button variant="warn" size="sm" disabled={busy === item.id} onClick={() => answer(item, true)}>Autoriser</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </DialogContent>
      )}
    </Dialog>
  );
}
