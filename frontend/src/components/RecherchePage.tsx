// Rechercher (0.4.2) : un champ, les agents en filtres (tous cochés), et les résultats groupés sous chaque agent : messages, tâches, fichiers.
// Un clic ouvre l'endroit trouvé. Ouverte par la barre de gauche, la loupe du fil et Ctrl K ; une page de la zone de travail, comme « Pour toi ».
import { FileText, ListChecks, Loader2, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/i18n";
import { type Agent, get } from "@/lib/api";
import { fileSpec } from "./FilePreview";
import { useViewer } from "./Viewer";

type Resultat = {
  q: string;
  total: number;
  agents: {
    id: string; nom: string; total: number;
    messages: { id: number; conversation_id: string; principale: boolean; role: string; texte: string; date: string }[];
    taches: { id: string; titre: string; etat: string; conversation_id: string }[];
    fichiers: { path: string; size?: number; modified?: number }[];
  }[];
};

export const MIN_LETTRES = 2;
const ATTENTE = 250; // millisecondes après la dernière touche

/** Le mot cherché en gras dans l'extrait. */
function Surligne({ texte, mot }: { texte: string; mot: string }) {
  const i = texte.toLowerCase().indexOf(mot.toLowerCase());
  if (i < 0 || !mot) return <>{texte}</>;
  return <>{texte.slice(0, i)}<b>{texte.slice(i, i + mot.length)}</b>{texte.slice(i + mot.length)}</>;
}

export function RecherchePage({ agents, onOpenFil, onOpenTache, onOpenFichier }: {
  agents: Agent[];
  /** Un message : le fil de son agent (principal) ou la conversation où il est. */
  onOpenFil: (agentId: string, conversationId: string | null) => void;
  onOpenTache: (agentId: string, conversationId: string) => void;
  onOpenFichier: (agentId: string) => void;
}) {
  const [mot, setMot] = useState("");
  const [decoches, setDecoches] = useState<Set<string>>(new Set());
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [cherche, setCherche] = useState(false);
  const [erreur, setErreur] = useState(false);
  const voir = useViewer();
  const champ = useRef<HTMLInputElement>(null);
  useEffect(() => champ.current?.focus(), []);
  const cochés = useMemo(() => agents.filter((a) => !decoches.has(a.id)), [agents, decoches]);
  const requete = mot.trim();
  const ids = cochés.map((a) => a.id).join(",");
  const tous = decoches.size === 0;

  useEffect(() => {
    if (requete.length < MIN_LETTRES || !cochés.length) { setResultat(null); setCherche(false); setErreur(false); return; }
    let vivant = true;
    setCherche(true);
    const timer = setTimeout(() => {
      get<Resultat>(`/api/recherche?q=${encodeURIComponent(requete)}${tous ? "" : `&agents=${encodeURIComponent(ids)}`}`)
        .then((r) => { if (vivant) { setResultat(r); setErreur(false); } })
        .catch(() => { if (vivant) setErreur(true); })
        .finally(() => { if (vivant) setCherche(false); });
    }, ATTENTE);
    return () => { vivant = false; clearTimeout(timer); };
  }, [requete, ids, tous, cochés.length]);

  const bascule = (id: string) => setDecoches((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next; });

  let corps: React.ReactNode;
  if (!cochés.length) corps = <p className="soft">{t("Coche au moins un agent pour chercher.")}</p>;
  else if (requete.length < MIN_LETTRES) corps = <p className="soft">{t("Écris au moins deux lettres : Noah cherche dans les messages, les tâches et les fichiers de tes agents.")}</p>;
  else if (erreur && !resultat) corps = <div className="empty" role="alert"><h2>{t("Ça n'a pas chargé")}</h2><p className="soft">{t("Noah n'a pas pu chercher. Réessaie dans un instant.")}</p></div>;
  else if (!resultat || resultat.q !== requete) corps = cherche ? <p className="soft" role="status"><Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden />{t("Je cherche…")}</p> : null;
  else if (!resultat.agents.length) corps = <div className="empty"><h2>{t("Rien trouvé")}</h2><p className="soft">{t("Aucun résultat pour « {mot} ».", { mot: requete })}</p></div>;
  else corps = (
    <div className="stack g32" data-resultats>
      {resultat.agents.map((a) => (
        <section key={a.id} className="stack g8" aria-label={a.nom} data-agent={a.id}>
          <h2 className="h2">{a.nom}</h2>
          <div className="list">
            {a.messages.map((m) => (
              <button key={`m${m.id}`} type="button" className="row text-left" data-message={m.id} onClick={() => onOpenFil(a.id, m.principale ? null : m.conversation_id)}>
                <MessageSquare className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
                <span className="grow stack min-w-0"><span className="row-title"><Surligne texte={m.texte} mot={requete} /></span><span className="row-sub">{m.role === "user" ? t("Toi") : a.nom}</span></span>
              </button>
            ))}
            {a.taches.map((x) => (
              <button key={`t${x.id}`} type="button" className="row text-left" data-tache={x.id} onClick={() => onOpenTache(a.id, x.conversation_id)}>
                <ListChecks className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
                <span className="grow stack min-w-0"><span className="row-title"><Surligne texte={x.titre} mot={requete} /></span><span className="row-sub">{t("Tâche")}</span></span>
              </button>
            ))}
            {a.fichiers.map((f) => (
              <button key={`f${f.path}`} type="button" className="row text-left" data-fichier={f.path} onClick={() => { onOpenFichier(a.id); voir({ kind: "element", element: fileSpec(a.id, f.path, f.size) }); }}>
                <FileText className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
                <span className="grow stack min-w-0"><span className="row-title"><Surligne texte={f.path.split("/").pop() ?? f.path} mot={requete} /></span><span className="row-sub">{f.path}</span></span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  return (
    <main className="chat-pane" aria-label={t("Rechercher")}>
      <header className="head"><div className="head-title flex min-w-0 grow items-center gap-2"><h1 className="cut">{t("Rechercher")}</h1></div></header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="col narrow stack g16">
          <div className="search-field">
            <Search size={18} aria-hidden />
            <input ref={champ} type="search" aria-label={t("Rechercher")} placeholder={t("Un mot, un nom de fichier, une tâche…")} value={mot} onChange={(e) => setMot(e.target.value)} />
          </div>
          {agents.length > 1 && (
            <div className="chips" role="group" aria-label={t("Chercher chez")}>
              {agents.map((a) => <button key={a.id} type="button" className="chip" aria-pressed={!decoches.has(a.id)} data-agent-chip={a.id} onClick={() => bascule(a.id)}>{a.name}</button>)}
            </div>
          )}
          <div aria-live="polite">{corps}</div>
          {resultat && resultat.q === requete && resultat.agents.length > 0 && <p className="sr-only">{t("{n} résultats", { n: resultat.total })}</p>}
        </div>
      </div>
    </main>
  );
}
