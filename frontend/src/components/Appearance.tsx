import { useState } from "react";
import { noahPaused, setNoahPaused } from "@/lib/noahFace";
import { usePrivacy } from "./SensitiveText";
import { LANGUES, type Langue, choisirLangue, langueChoisie, t } from "@/i18n";

/** Une ligne de réglage du prototype : le titre, son aide, et le contrôle à droite. */
export function ReglageLigne({ titre, aide, children }: { titre: string; aide?: string; children: React.ReactNode }) {
  return <div className="set-row"><div className="grow" style={{ minWidth: 0 }}><b>{titre}</b>{aide && <span className="help block">{aide}</span>}</div>{children}</div>;
}

/** Un interrupteur (role switch) : la même case à cocher qu'avant, dessinée comme celle du prototype. */
export function Interrupteur({ libelle, on, onChange }: { libelle: string; on: boolean; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={libelle} className="toggle" onClick={() => onChange(!on)} />;
}

function Choix<T extends string>({ libelle, valeur, options, onChange }: { libelle: string; valeur: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg" role="group" aria-label={libelle}>{options.map(([v, label]) => <button key={v} type="button" aria-pressed={valeur === v} onClick={() => onChange(v)}>{label}</button>)}</div>;
}

/** Le mouvement des visages se coupe ici : le réglage reste sur cet appareil. */
function FaceMotion() {
  const [still, setStill] = useState(noahPaused);
  return <ReglageLigne titre={t("Visages immobiles")} aide={t("Sur cet appareil.")}><Interrupteur libelle={t("Visages immobiles")} on={still} onChange={(v) => { setStill(v); setNoahPaused(v); }} /></ReglageLigne>;
}

export function Appearance() {
  const { preferences, save, error } = usePrivacy();
  return (
    <section aria-label={t("Apparence")} className="flex flex-col">
      <ReglageLigne titre={t("Langue")} aide={t("La page se recharge quand tu en changes.")}>
        <select aria-label={t("Langue")} className="select" style={{ width: 210, maxWidth: "100%" }} value={langueChoisie() ?? ""} onChange={(e) => choisirLangue((e.target.value || null) as Langue | null)}>
          <option value="">{t("Celle du navigateur")}</option>
          {(Object.keys(LANGUES) as Langue[]).map((l) => <option key={l} value={l}>{LANGUES[l]}</option>)}
        </select>
      </ReglageLigne>
      <ReglageLigne titre={t("Thème")} aide={t("Clair, sombre, ou comme ton appareil.")}>
        <Choix libelle={t("Thème")} valeur={preferences.theme} onChange={(v) => void save({ theme: v })} options={[["light", t("Clair")], ["dark", t("Sombre")], ["system", t("Système")]]} />
      </ReglageLigne>
      <ReglageLigne titre={t("Taille du texte")} aide={t("Pour tout Noah, sur cet appareil.")}>
        <Choix libelle={t("Taille du texte")} valeur={preferences.texte} onChange={(v) => void save({ texte: v })} options={[["petit", t("Petit")], ["normal", t("Normal")], ["grand", t("Grand")]]} />
      </ReglageLigne>
      <ReglageLigne titre={t("Masquer les données sensibles")} aide={t("Courriels, téléphones et cartes dans les textes. Le contenu des images et PDF, les adresses postales restent visibles. Avant un envoi, le destinataire s'affiche en entier dans la demande d'accord.")}>
        <Interrupteur libelle={t("Masquer les données sensibles")} on={preferences.masquer_sensibles} onChange={(v) => void save({ masquer_sensibles: v })} />
      </ReglageLigne>
      <FaceMotion />
      {error && <p role="alert" className="text-danger">{error}</p>}
    </section>
  );
}
