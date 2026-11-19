import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/react";
import { Check, ChevronRight, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { useContext, useEffect, useId, useMemo, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import type { TraceDetail } from "@/lib/api";
import type { TacheDuFil } from "@/lib/ouverture";
import { cn } from "@/lib/utils";
import { StateShape } from "../Sidebar";
import { t } from "@/i18n";
import { type ACorriger, CorrigerDialog, DECISION_CORRIGEE } from "../Corriger";
import { QUESTION_REPONDUE, QuestionCard } from "../QuestionCard";

// Une tâche dans le fil (0.4.0, prototype « Fil calme ») : une ligne repliée (le titre, qui travaille, où elle en est) qu'on déplie sur place,
// et dans laquelle on entre. C'est la même ligne dans le fil et dans l'onglet Tâches d'Activité : les deux lisent la même tâche
// (`GET /api/taches`, `ouverture.fil.taches`). Elle remplace la ligne de trace (TraceLine) : la trace d'un fil sans tâche connue se lit
// encore, par `TraceOutil`. La ligne nomme celui qui fait le travail (`tache.agent`), jamais celui qui l'a demandée.

export const etatDit = (etat: TacheDuFil["etat"]): string => ({ encours: t("en cours"), attend: t("attend ta réponse"), fini: t("terminée"), echec: t("a échoué") })[etat];

/** La pastille d'état d'une tâche : son texte et sa couleur (en cours : bleu ; attend : orange ; terminée : vert ; échec : rouge). */
export const etatPastille = (etat: TacheDuFil["etat"]): { texte: string; genre: "work" | "wait" | "ok" | "err" } =>
  ({ encours: { texte: t("En cours"), genre: "work" as const }, attend: { texte: t("Attend ta réponse"), genre: "wait" as const }, fini: { texte: t("Terminée"), genre: "ok" as const }, echec: { texte: t("A échoué"), genre: "err" as const } })[etat];

/** L'adresse d'une tâche : son fil, que l'application ouvre (même adresse que les notifications). */
export const adresseDe = (agentId: string, conversationId: string) => `#agent=${agentId}&conversation=${conversationId}`;

/** Qui fait le travail : l'agent de la tâche ; à défaut (une ancienne réponse du serveur), celui dont on lit le fil. */
export const travailleur = (tache: TacheDuFil, repli: string): string => tache.agent?.nom || repli;

/** « en cours depuis 2 min » ou « terminée en 4 min » : la durée, quand elle se lit. */
function duree(tache: TacheDuFil): string {
  const fin = tache.etat === "encours" || tache.etat === "attend" ? Date.now() / 1000 : tache.fini_a;
  const minutes = fin && tache.cree ? Math.max(0, Math.round((fin - tache.cree) / 60)) : 0;
  if (!minutes || minutes > 600) return etatDit(tache.etat);
  if (tache.etat === "encours") return t("en cours depuis {n} min", { n: minutes });
  if (tache.etat === "fini") return t("terminée en {n} min", { n: minutes });
  return etatDit(tache.etat);
}

const nomDeFichier = (f: unknown): string => {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const o = f as { nom?: string; name?: string; path?: string };
    return String(o.nom ?? o.name ?? o.path ?? "");
  }
  return "";
};

/** Le groupe de lignes de tâche voisines : l'en-tête « 3 tâches · 1 terminée » se montre sur la première ; les autres s'y collent. */
export type GroupeTaches = { premier: boolean; total: number; finies: number };

export function TacheLigne({ tache, agentId, agentName, defaultOpen = false, onOpen, groupe }: {
  tache: TacheDuFil;
  agentId: string;
  /** Celui dont on lit le fil : repli quand la tâche ne dit pas qui travaille. */
  agentName: string;
  defaultOpen?: boolean;
  /** Entrer dans la tâche, sans passer par l'adresse (l'onglet Tâches). */
  onOpen?: (conversationId: string) => void;
  groupe?: GroupeTaches;
}) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const [corriger, setCorriger] = useState<ACorriger | null>(null);
  const [corrigees, setCorrigees] = useState<Record<string, string>>({});
  const [repondue, setRepondue] = useState(false);
  useEffect(() => {  // la même question répondue ailleurs (« Pour toi », la page de la tâche) disparaît d'ici aussi
    const on = (e: Event) => { if ((e as CustomEvent<{ id: string }>).detail?.id === tache.question?.id) setRepondue(true); };
    window.addEventListener(QUESTION_REPONDUE, on);
    return () => window.removeEventListener(QUESTION_REPONDUE, on);
  }, [tache.question?.id]);
  useEffect(() => {  // une décision corrigée (ici ou dans Activité) montre la réponse de la personne
    const on = (e: Event) => { const d = (e as CustomEvent<{ id: string; correction: string }>).detail; if (d?.id) setCorrigees((cur) => ({ ...cur, [d.id]: d.correction })); };
    window.addEventListener(DECISION_CORRIGEE, on);
    return () => window.removeEventListener(DECISION_CORRIGEE, on);
  }, []);
  const open = asked ?? (defaultOpen || tache.etat === "attend");
  const id = useId();
  const qui = travailleur(tache, agentName);
  const meta = tache.etat === "fini" || tache.etat === "encours" ? [qui, duree(tache)].join(" · ") : [qui, etatDit(tache.etat)].join(" · ");
  const attend = tache.etat === "attend";
  const files = (tache.fichiers ?? []).map(nomDeFichier).filter(Boolean);
  const etapes = tache.etapes ?? [];
  const entrer = tache.conversation_id ? (
    onOpen ? (
      <button type="button" className="task-open" onClick={() => onOpen(tache.conversation_id)}>
        {t("Ouvrir la tâche")}<ChevronRight className="size-4" aria-hidden />
      </button>
    ) : (
      <a href={adresseDe(agentId, tache.conversation_id)} className="task-open">
        {t("Ouvrir la tâche")}<ChevronRight className="size-4" aria-hidden />
      </a>
    )
  ) : null;
  const entete = groupe?.premier
    ? [groupe.total > 1 ? t("{n} tâches", { n: groupe.total }) : t("{n} tâche", { n: groupe.total }), groupe.finies > 1 ? t("{n} terminées", { n: groupe.finies }) : groupe.finies === 1 ? t("{n} terminée", { n: 1 }) : ""].filter(Boolean).join(" · ")
    : "";
  return (
    <div data-tache={tache.id} data-etat={tache.etat}>
      {entete && <div className="list-head">{entete}</div>}
      <button type="button" aria-expanded={open} aria-controls={`${id}-detail`} onClick={() => setAsked(!open)} className="task">
        <span className="task-state">{tache.etat === "fini" ? <Check className="size-[18px] text-ok" aria-hidden /> : <StateShape state={tache.etat === "attend" ? "approve" : tache.etat === "echec" ? "error" : "work"} />}</span>
        <span className="grow flex min-w-0 flex-col">
          <span className="row-title">{tache.titre}</span>
          <span className={cn("task-meta md:hidden", attend && "task-meta-wait")}>{meta}</span>
        </span>
        {attend ? <span className="pill wait max-md:hidden">{[qui, etatDit(tache.etat)].join(" · ")}</span> : <span className="task-meta max-md:hidden">{meta}</span>}
        <ChevronRight aria-hidden className={cn("chev", open && "is-open")} />
      </button>
      {open && (
        <div id={`${id}-detail`} className="sub">
          {etapes.length > 0 && <p className="text-[13px] text-muted-foreground">{etapes.join(" · ")}</p>}
          {(tache.echanges ?? []).map((x, i) => {
            const corrigee = x.id ? corrigees[x.id] : undefined;
            return (
              <div key={x.id ?? i} className="xchg">
                <div className="xchg-line"><b>{x.de} {t("à")} {x.a}</b><span>{x.question}</span></div>
                <div className="xchg-line"><b>{x.a} {t("à")} {x.de}</b><span>{corrigee ?? x.reponse}</span></div>
                {x.id && (
                  <div className="line wrap g8 small soft text-[13px] text-muted-foreground">
                    <span className="grow" style={{ minWidth: 180 }}>{corrigee || x.corrigee ? t("Corrigé par toi. Règle retenue.") : t("Réglé entre agents, sans te déranger.")}</span>
                    <button type="button" className="btn btn-sm" onClick={() => setCorriger({ id: x.id as string, question: x.question, reponse: corrigee ?? x.reponse, qui: t("{a} a répondu à {de}", { a: x.a, de: x.de }) })}>{t("Corriger")}</button>
                  </div>
                )}
              </div>
            );
          })}
          {tache.question && !repondue && <QuestionCard q={tache.question} dansTache />}
          {tache.demandeur?.nom && <p className="text-[13px] text-muted-foreground">{t("Confiée par {nom}", { nom: tache.demandeur.nom })}</p>}
          <p className="whitespace-pre-wrap break-words">{tache.resume || (tache.etat === "encours" ? t("Le travail est en cours.") : tache.etat === "attend" ? t("Le travail attend ta réponse.") : t("Pas de compte rendu."))}</p>
          {files.length > 0 && <div className="flex flex-wrap items-center gap-2">{files.map((f) => <span key={f} className="file">{/\.(png|jpe?g|gif|webp)$/i.test(f) ? <ImageIcon className="size-[18px]" aria-hidden /> : <FileIcon className="size-[18px]" aria-hidden />}<span className="cut">{f}</span></span>)}</div>}
          {entrer && <div>{entrer}</div>}
        </div>
      )}
      <CorrigerDialog cible={corriger} onClose={() => setCorriger(null)} />
    </div>
  );
}

/** Les lignes de tâche voisines de celle-ci dans le fil, comptées pour l'en-tête du groupe. Une chaîne : rien ne se redessine pour un compte inchangé. */
function useGroupe(): GroupeTaches | undefined {
  const key = useAuiState((s) => {
    type Msg = { content: readonly { type: string; toolName?: string; args?: unknown }[] } | undefined;
    const part = (m: Msg) => m?.content.find((p) => p.type === "tool-call" && (p.toolName === "tache" || p.toolName === "trace"));
    const fini = (m: Msg) => {
      const p = part(m);
      const args = p?.args as { tache?: { etat?: string }; etat?: string } | undefined;
      return (p?.toolName === "tache" ? args?.tache?.etat : args?.etat) === "fini";
    };
    const i = s.message.index;
    if (!part(s.thread.messages[i] as Msg) || part(s.thread.messages[i - 1] as Msg)) return JSON.stringify({ premier: false, total: 0, finies: 0 });
    let total = 0, finies = 0;
    for (let k = i; part(s.thread.messages[k] as Msg); k++) {
      total++;
      if (fini(s.thread.messages[k] as Msg)) finies++;
    }
    return JSON.stringify({ premier: true, total, finies });
  });
  return useMemo(() => JSON.parse(key) as GroupeTaches, [key]);
}

/** La ligne d'une tâche, dans le fil : la partie « outil » que `useAgentChat` pose à la place du message de trace. */
export function TacheOutil({ args }: ToolCallMessagePartProps) {
  const { agentId, agentName } = useContext(AgentContext);
  const tache = (args as unknown as { tache: TacheDuFil }).tache;
  return <TacheLigne tache={tache} agentId={agentId} agentName={agentName} groupe={useGroupe()} />;
}

/** Une trace de fil dont la tâche n'est pas (encore) connue de l'écran : la même ligne, faite de ce que la trace dit. La trace est écrite dans le fil de celui qui travaille. */
export function TraceOutil({ args }: ToolCallMessagePartProps) {
  const { agentId, agentName } = useContext(AgentContext);
  const trace = args as unknown as TraceDetail;
  const tache: TacheDuFil = {
    id: `trace-${trace.fil}`, titre: trace.consigne, genre: "demande", demandeur: null, agent: { id: agentId, nom: agentName },
    etat: trace.etat === "fini" ? "fini" : trace.etat === "echec" ? "echec" : "encours",
    resume: trace.issue ?? "", fichiers: [], ancre: 0, cree: 0, fini_a: null, conversation_id: trace.fil, question: null,
  };
  return <TacheLigne tache={tache} agentId={agentId} agentName={agentName} groupe={useGroupe()} />;
}
