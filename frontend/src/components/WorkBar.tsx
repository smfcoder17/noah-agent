// Les icônes du haut à droite de la conversation, celles du prototype « Fil calme » : appeler l'agent, son ordinateur (accès direct
// à son écran, demandé par Franck en 0.4.4), ouvrir ou fermer le panneau de droite.
// Les contenus de l'agent (Activité, Tâches, Fichiers, Ordinateur, Session, Connexions) et les détails techniques sont dans le panneau,
// sous forme d'onglets ; l'appel est le mode vocal, qui était à côté de la saisie.
import { Monitor, PanelRight, Phone, Search } from "lucide-react";
import type { PanelTab } from "./SidePanel";
import { type Agent, canTalk } from "@/lib/api";
import { MODE_VOCAL } from "@/lib/workPanel";
import { t } from "@/i18n";

type Props = { agent: Agent | null; active: PanelTab | null; onOpen: (tab: PanelTab) => void; waiting?: number; onInbox?: () => void; onSearch?: () => void };

const call = () => window.dispatchEvent(new Event(MODE_VOCAL));

/** Le panneau après un clic sur une icône. L'ordinateur s'ouvre sur son onglet, quel que soit l'onglet affiché, et se referme s'il
 *  est déjà affiché ; l'icône du panneau le ferme, ou le rouvre sur l'onglet où on l'avait laissé (`garde`). */
export function panneauApres(ouvert: PanelTab | null, demande: PanelTab, garde: PanelTab): PanelTab | null {
  if (demande === "computer") return ouvert === "computer" ? null : "computer";
  return ouvert ? null : garde;
}

/** Appeler, l'ordinateur, puis le panneau. Sur ordinateur dans l'en-tête du fil ; sur téléphone dans celui du téléphone (voir WorkMenu). */
function Icons({ agent, active, onOpen, onSearch }: Props) {
  return (
    <>
      {onSearch && <button type="button" className="icon-btn cible-tactile" aria-label={t("Rechercher")} title={t("Rechercher")} onClick={onSearch}><Search size={18} aria-hidden /></button>}
      <button type="button" className="icon-btn cible-tactile" aria-label={t("Appeler {nom}", { nom: agent?.name ?? "" })} title={t("Appeler {nom}", { nom: agent?.name ?? "" })} disabled={!agent || !canTalk(agent)} onClick={call}>
        <Phone size={18} aria-hidden />
      </button>
      <button type="button" className="icon-btn cible-tactile" aria-label={t("Ordinateur de {nom}", { nom: agent?.name ?? "" })} title={t("Ordinateur de {nom}", { nom: agent?.name ?? "" })} aria-pressed={active === "computer"} disabled={!agent || !canTalk(agent)} onClick={() => onOpen("computer")}>
        <Monitor size={18} aria-hidden />
      </button>
      <button type="button" className="icon-btn cible-tactile" aria-label={t("Ouvrir ou fermer le panneau")} title={t("Ouvrir ou fermer le panneau")} aria-pressed={!!active} disabled={!agent} onClick={() => onOpen(active ?? "activity")}>
        <PanelRight size={18} aria-hidden />
      </button>
    </>
  );
}

export function WorkBar(props: Props) {
  return <nav className="work-bar" aria-label={t("Contenus de l'agent")}><Icons {...props} /></nav>;
}

/** Le téléphone : « Pour toi » avec son nombre, puis les mêmes deux icônes. */
export function WorkMenu(props: Props) {
  const { waiting = 0, onInbox } = props;
  return (
    <nav className="work-bar" aria-label={t("Contenus de l'agent")}>
      {waiting > 0 && <button type="button" className="pill wait pour-toi-pill" onClick={onInbox}>{t("Pour toi")}<span className="badge">{waiting}</span></button>}
      <Icons {...props} />
    </nav>
  );
}
