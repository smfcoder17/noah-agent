// Un message de la personne qui cite des agents, des fichiers, des dossiers ou une compétence : les pastilles se réaffichent dans le texte.
// Un fichier s'ouvre au clic (l'aperçu de l'application), un dossier ouvre l'onglet Fichiers. Chargé à la demande : seuls les messages à pastilles le lisent.
import "@/styles/mentions.css";
import { AtSign, FileText, Folder, Sparkles } from "lucide-react";
import { useContext, useMemo } from "react";
import { AgentContext } from "@/lib/agentContext";
import { rawFileUrl } from "@/lib/api";
import { AGENTS_TTL, agentsKey, agentsPath, splitMentions, useCached, type AgentHit, type Mention } from "@/lib/mentions";
import { t } from "@/i18n";
import { AgentFace } from "../Noah";
import { SensitiveText } from "../SensitiveText";
import { canFrame, useDownload, useViewer } from "../Viewer";

const PILL = "mention-pill";

export default function MentionText({ text }: { text: string }) {
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  const download = useDownload();
  const parts = useMemo(() => splitMentions(text), [text]);
  const withAgent = parts.some((p) => typeof p !== "string" && p.kind === "agent");
  // Le visage d'un agent cité : la liste que la saisie lit déjà, une seule fois pour tous les messages, et seulement s'il y en a un.
  const agents = useCached<{ agents: AgentHit[] }>(withAgent ? agentsKey(agentId) : null, agentsPath(agentId), AGENTS_TTL, { agents: [] });

  const pill = (m: Mention, key: number) => {
    if (m.kind === "fichier") {
      const url = rawFileUrl(agentId, m.ref);
      return (
        <button key={key} type="button" className={PILL} data-mention-pill="fichier" title={m.ref}
          onClick={() => (canFrame(url) ? view({ kind: "file", url, title: m.label }) : download(`${url}?download=1`, m.label))}>
          <FileText aria-hidden />{m.label}
        </button>
      );
    }
    if (m.kind === "dossier") {
      return (
        <button key={key} type="button" className={PILL} data-mention-pill="dossier" title={m.ref}
          onClick={() => window.dispatchEvent(new CustomEvent("noah:ouvrir-panneau", { detail: "files" }))}>
          <Folder aria-hidden />{m.label}
        </button>
      );
    }
    if (m.kind === "agent") {
      const known = agents.data?.agents.find((a) => a.id === m.ref);
      return (
        <span key={key} className={PILL} data-mention-pill="agent" title={known?.role || undefined}>
          {known ? <AgentFace agent={{ id: known.id, color: known.color, shape: known.shape, detail: known.detail }} className="size-4" /> : <AtSign aria-hidden />}{m.label}
        </span>
      );
    }
    return (
      <span key={key} className={PILL} data-mention-pill="competence" title={t("Compétence")}>
        <Sparkles aria-hidden />{m.label}
      </span>
    );
  };

  return <>{parts.map((p, i) => (typeof p === "string" ? <SensitiveText key={i} text={p} /> : pill(p, i)))}</>;
}
