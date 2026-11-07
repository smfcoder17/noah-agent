// « À toi » : tout ce qui attend la personne, tous agents confondus. Un accord se donne ici ; le reste ouvre la conversation.
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Agent, get, type InboxItem, send } from "@/lib/api";
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
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError("");
    get<InboxItem[]>("/api/a-toi").then(setItems).catch((e) => setError((e as Error).message));
    // Un agent peut demander autre chose pendant que la fenêtre est ouverte.
    const timer = setInterval(() => get<InboxItem[]>("/api/a-toi").then(setItems).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [open]);
  const answer = async (item: InboxItem, approve: boolean) => {
    setBusy(item.conversation_id);
    setError("");
    try {
      await send(`/api/agents/${item.agent_id}/runs/${item.run_id}/approval`, { request_id: item.request_id, generation: item.generation, approve });
      setItems((cur) => cur?.filter((i) => i.request_id !== item.request_id) ?? null); // un accord suivant reste à donner
      get<InboxItem[]>("/api/a-toi").then(setItems).catch(() => {});
      window.dispatchEvent(new CustomEvent("noah:accord-repondu", { detail: { request_id: item.request_id, result: approve ? "approved" : "denied" } }));
    } catch (e) {
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
          {items?.length === 0 && <p className="py-4 text-sm text-muted-foreground">Rien ne t'attend pour le moment.</p>}
          <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {items?.map((item) => {
              const agent = agents.find((a) => a.id === item.agent_id);
              return (
                <li key={item.conversation_id} className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
                  <button type="button" onClick={() => onOpenConversation(item)} className="flex w-full cursor-pointer items-start gap-3 text-left" aria-label={`Ouvrir la conversation : ${item.demande}`}>
                    {agent && <AgentFace agent={agent} className="size-9 shrink-0" />}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-warn">
                        <StateShape state={item.etat} />
                        {item.etat === "approve" ? "Attend ton accord" : "Attend ton choix"}
                      </span>
                      <span className="text-sm font-medium">{item.demande}</span>
                      {item.apercu.map((line) => <span key={line} className="truncate text-xs text-muted-foreground">« {line} »</span>)}
                      <span className="truncate text-xs text-muted-foreground">{item.agent}{item.main ? "" : ` · ${item.titre}`}</span>
                    </span>
                  </button>
                  {item.etat === "approve" && item.run_id && (
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" disabled={busy === item.conversation_id} onClick={() => answer(item, false)}>Refuser</Button>
                      <Button variant="warn" size="sm" disabled={busy === item.conversation_id} onClick={() => answer(item, true)}>Autoriser</Button>
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
