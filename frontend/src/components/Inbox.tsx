import { subscribeUpdates } from "@/lib/events";
// « À toi » : tout ce qui attend la personne, tous agents confondus. Un accord se donne ici ; le reste ouvre la conversation.
import { Lightbulb, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { type Agent, get, type InboxItem, isProposition, type Proposition, send } from "@/lib/api";
import { refreshAccords, useAccords } from "@/lib/events";
import { refreshPropositions, setPropositionCount } from "@/lib/propositions";
import { LoginCard } from "./LoginCard";
import { QUESTION_REPONDUE, QuestionCard } from "./QuestionCard";
import { AgentFace } from "./Noah";
import { Button, Dialog, DialogContent, ErrorText } from "./ui";

/** Une idée de l'agent : « Fais-le » la lance dans sa conversation principale, « Non » la range (et il s'en souvient). */
export function PropositionCard({ item, agent, onAnswer }: { item: Proposition; agent?: Agent; onAnswer: (choix: "faire" | "non") => void }) {
  return (
    <li className="card">
      <div className="flex items-start gap-3">
        {agent && <AgentFace agent={agent} className="size-9 shrink-0" />}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Lightbulb className="size-3.5" aria-hidden />{t("{agent} te propose", { agent: item.agent })}</span>
          <span className="whitespace-pre-wrap break-words text-sm font-medium">{item.texte}</span>
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" className="max-md:h-10 max-md:px-4" aria-label={t("Non, pas cette proposition de {agent}", { agent: item.agent })} onClick={() => onAnswer("non")}>{t("Non")}</Button>
        <Button size="sm" className="max-md:h-10 max-md:px-4" aria-label={t("Fais-le : lancer la proposition de {agent}", { agent: item.agent })} onClick={() => onAnswer("faire")}>{t("Fais-le")}</Button>
      </div>
    </li>
  );
}

export function Inbox({ open, page = false, agents, onOpenChange, onOpenConversation, onOpenAgent }: {
  open: boolean;
  /** Dans la zone de travail, comme le prototype, au lieu d'une fenêtre. */
  page?: boolean;
  agents: Agent[];
  onOpenChange: (open: boolean) => void;
  onOpenConversation: (item: InboxItem) => void;
  /** Ouvre la conversation principale de cet agent. */
  onOpenAgent?: (agentId: string) => void;
}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [propositions, setPropositions] = useState<Proposition[]>([]);
  const answered = useRef(new Set<string>()); // une relecture pendant l'envoi ne la fait pas revenir
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const { items: accords } = useAccords();
  useEffect(() => {  // une question répondue (ici, dans la tâche ou dans le fil) quitte la liste sans attendre la relève
    const on = (e: Event) => { const id = (e as CustomEvent<{ id: string }>).detail?.id; setItems((cur) => cur?.filter((i) => i.question?.id !== id) ?? null); };
    window.addEventListener(QUESTION_REPONDUE, on);
    return () => window.removeEventListener(QUESTION_REPONDUE, on);
  }, []);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError("");
    const load = () => get<(InboxItem | Proposition)[]>("/api/a-toi").then((rows) => {
      const ideas = rows.filter((r): r is Proposition => isProposition(r as { type?: string }));
      setPropositions(ideas.filter((p) => !answered.current.has(p.id)).sort((a, b) => a.cree - b.cree));
      setItems(rows.filter((r): r is InboxItem => !isProposition(r as { type?: string }) && !(r as InboxItem).request_id));
    }).catch((e) => setError((e as Error).message));
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
      setError(t("La réponse n'a pas été prise en compte : {erreur}", { erreur: (e as Error).message }));
    } finally {
      setBusy("");
    }
  };
  /** La carte part tout de suite. Déjà répondue ailleurs ou expirée (404, 409) : elle ne revient pas. Le réseau ou le serveur
   *  en panne (5xx) : elle revient, avec « Réessaie ». */
  const reply = async (item: Proposition, choix: "faire" | "non") => {
    setError("");
    answered.current.add(item.id);
    setPropositions((cur) => {
      const left = cur.filter((p) => p.id !== item.id);
      setPropositionCount(left.length);
      return left;
    });
    try {
      await send(`/api/propositions/${encodeURIComponent(item.id)}/reponse`, { choix });
      if (choix === "faire") onOpenAgent?.(item.agent_id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409) {
        setError(t("Cette proposition n'attend plus de réponse : elle a déjà été traitée ou elle a expiré."));
        return;
      }
      if (status && status < 500) {
        setError((e as Error).message);
        return;
      }
      answered.current.delete(item.id);
      setPropositions((cur) => [...cur.filter((p) => p.id !== item.id), item].sort((a, b) => a.cree - b.cree));
      setError(choix === "faire" ? t("{agent} n'a pas pu lancer cette proposition. Réessaie dans un instant.", { agent: item.agent }) : t("Ta réponse n'est pas passée. Réessaie dans un instant."));
    } finally {
      void refreshPropositions().catch(() => {});
    }
  };
  const decisions = (items?.length ?? 0) + accords.length + propositions.length;
  const phrase = decisions === 1 ? t("Une décision te revient. Le reste se règle entre agents.") : decisions > 1 ? t("{n} décisions te reviennent. Le reste se règle entre agents.", { n: decisions }) : "";
  const corps = (
    <>
        <ErrorText>{error}</ErrorText>
      {!page && phrase ? <p className="soft text-muted-foreground">{phrase}</p> : null}
        {!items && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
        {items?.length === 0 && !accords.length && !propositions.length && <p className="py-4 text-sm text-muted-foreground">{t("Rien ne t'attend pour le moment.")}</p>}
        <ul className={page ? "stack g16" : "flex max-h-[70vh] flex-col gap-4 overflow-y-auto max-md:max-h-none max-md:overflow-visible"}>
          {[...accords, ...(items ?? [])].sort((a, b) => a.created - b.created).map((item) => {
            if (item.question) return <li key={item.id ?? item.conversation_id}><QuestionCard q={item.question} onTache={() => onOpenConversation(item)} /></li>;
            return (
              <li key={item.id ?? item.conversation_id} className="card">
                <button type="button" onClick={() => onOpenConversation(item)} className="stack g8 w-full cursor-pointer text-left" aria-label={t("Ouvrir la conversation : {demande}", { demande: item.demande })}>
                  <span className="line wrap g8 text-[13px] text-muted-foreground">
                    <span>{item.agent}{item.main ? "" : ` · ${item.titre}`}</span>
                    <span className="pill wait">{item.connexion ? t("Attend ta connexion") : item.appel ? t("Attend ton aide") : item.etat === "approve" ? t("Attend ton accord") : t("Attend ton choix")}</span>
                  </span>
                  <span className="text-[19px] font-semibold leading-snug">{item.demande}</span>
                  {item.pourquoi && <span className="text-muted-foreground">{item.pourquoi}</span>}
                  {item.apercu.map((line) => <span key={line} className="text-muted-foreground">{t("« {phrase} »", { phrase: line })}</span>)}
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
                {item.bureau ? <p className="text-sm text-muted-foreground">{t("À accepter sur ton ordinateur")}</p> : item.etat === "approve" && item.run_id && (
                  <div className="line wrap g8">
                    <button type="button" className="btn btn-ink" disabled={busy === item.id} onClick={() => answer(item, true)}>{t("Autoriser")}</button>
                    <button type="button" className="btn" disabled={busy === item.id} onClick={() => answer(item, false)}>{t("Refuser")}</button>
                  </div>
                )}
              </li>
            );
          })}
          {propositions.map((p) => <PropositionCard key={p.id} item={p} agent={agents.find((a) => a.id === p.agent_id)} onAnswer={(choix) => void reply(p, choix)} />)}
        </ul>
    </>
  );
  if (page) {  // la page du prototype : dans la zone de travail, un titre de 26 px, une phrase, des cartes
    return (
      <main className="chat-pane" aria-label={t("Pour toi")}>
        <header className="head"><div className="head-title flex min-w-0 grow items-center gap-2"><h1 className="cut">{t("Pour toi")}</h1></div></header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="col narrow stack g16">
            <div className="stack g4"><h2 className="title">{t("Pour toi")}</h2>{phrase ? <p className="soft text-muted-foreground">{phrase}</p> : null}</div>
            {corps}
          </div>
        </div>
      </main>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title={t("Pour toi")} description={t("Ce que tes agents attendent de toi.")} className="max-w-2xl">
          {corps}
        </DialogContent>
      )}
    </Dialog>
  );
}
