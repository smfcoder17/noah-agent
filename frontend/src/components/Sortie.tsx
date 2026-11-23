// Réglages > Serveur > Sortie réseau : par où les navigateurs des agents sortent sur Internet.
// En haut, une phrase qui dit où l'on en est. Puis l'interrupteur « Mes agents sortent par cet ordinateur » (dans l'app de bureau ;
// sinon une ligne dit où l'allumer). Le VPN, pour quand l'ordinateur est éteint, est rangé sous « Avancé » : le fichier collé part
// scellé au serveur et ne revient jamais, le champ reste vide.
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n";
import { del, get, send } from "@/lib/api";
import { desktop, type RelaisBureau } from "@/lib/desktop";
import { Interrupteur, ReglageLigne } from "./Appearance";
import { Button, ErrorText, Label, Textarea } from "./ui";

type Phase = "sans_relais" | "relais_eteint" | "relais_connecte" | "relais_actif";
type Resume = {
  phase: Phase;
  relais: { voulu: boolean; connecte: boolean; nom: string; adresse: string; lieu: string };
  vpn: { configure: boolean; fournisseur: string; etat: "non_configure" | "en_attente" | "pret" | "actif" | "injoignable"; adresse: string; lieu: string; ville: string };
  serveur: { adresse: string };
  active: string | null;
  lanceur: boolean;
};

const TELECHARGER = "https://github.com/smfcoder17/noah-agent/releases/latest";

/** La phrase du haut : où sortent les agents, en mots simples. */
function phrase(s: Resume, bureau: RelaisBureau | null): string {
  const nom = s.relais.nom || bureau?.nom || t("ton ordinateur");
  if (s.phase === "relais_actif") {
    return s.relais.lieu ? t("Tes agents sortent par ton ordinateur ({nom}), à {lieu}", { nom, lieu: s.relais.lieu }) : t("Tes agents sortent par ton ordinateur ({nom})", { nom });
  }
  if (s.phase === "relais_connecte") return t("Ton ordinateur ({nom}) est relié : tes agents sortiront par lui dans un instant", { nom });
  if (s.phase === "relais_eteint") return s.active === "vpn" ? t("Ton ordinateur est éteint : ils sortent par ton VPN") : t("Ton ordinateur est éteint : ils sortent par le serveur");
  if (s.active === "vpn") return t("Tes agents sortent par ton VPN");
  return bureau ? t("Tes agents sortent par le serveur") : t("Installe l'app Noah sur ton ordinateur pour les faire sortir de chez toi");
}

export function Sortie() {
  const [s, setS] = useState<Resume | null>(null);
  const [bureau, setBureau] = useState<RelaisBureau | null>(null);
  const [error, setError] = useState("");
  const app = desktop();
  const load = useCallback(async () => {
    try {
      setS(await get<Resume>("/api/sortie"));
      setBureau((await app?.relais?.()) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [app]);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000); // le relais se branche et se débranche tout seul : l'écran suit
    return () => clearInterval(id);
  }, [load]);

  if (!s) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>;

  const dansApp = !!app?.relaisActiver;
  const basculer = async (on: boolean) => {
    setError("");
    try {
      setBureau((await app?.relaisActiver?.(on)) ?? null);
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-4 text-sm" data-sortie data-phase={s.phase}>
      <p className="text-base font-medium" data-sortie-etat>{phrase(s, dansApp ? bureau ?? { voulu: false, etat: "arret", connexions: 0, nom: "" } : null)}</p>
      {s.phase === "sans_relais" && !dansApp && s.active !== "vpn" && (
        <p><a className="underline" href={TELECHARGER} target="_blank" rel="noreferrer">{t("Télécharger l'app Noah")}</a></p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {dansApp ? (
        <>
          <ReglageLigne titre={t("Mes agents sortent par cet ordinateur")} aide={t("Les sites voient l'adresse de ton accès Internet. Ça marche tant que l'app Noah reste ouverte, même fenêtre fermée.")}>
            <Interrupteur libelle={t("Mes agents sortent par cet ordinateur")} on={bureau?.voulu ?? false} onChange={basculer} />
          </ReglageLigne>
          {bureau?.etat === "remplace" && <p className="note">{t("Un autre ordinateur a pris la place : celui-ci ne sert plus de sortie.")}</p>}
        </>
      ) : (
        <p className="note" data-sortie-aide>{t("Pour que tes agents sortent par ton ordinateur, active « Mes agents sortent par cet ordinateur » depuis l'app Noah (menu Fichier, ou l'icône près de l'horloge).")}</p>
      )}
      <p className="note">{t("Les navigateurs déjà ouverts changent de sortie à leur prochain réveil, jamais en pleine session.")}</p>
      <Avance vpn={s.vpn} onDone={load} onError={setError} />
    </div>
  );
}

const ETATS_VPN: Record<Resume["vpn"]["etat"], () => string> = {
  non_configure: () => "",
  en_attente: () => t("En attente"),
  pret: () => t("Prêt"),
  actif: () => t("Actif"),
  injoignable: () => t("Injoignable"),
};

function Avance({ vpn, onDone, onError }: { vpn: Resume["vpn"]; onDone: () => void; onError: (m: string) => void }) {
  const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError("");
    try {
      await action();
      setConf("");
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="flex flex-col gap-2" data-sortie-avance>
      <summary className="cursor-pointer font-medium">{t("Avancé")}</summary>
      <section className="stack g8 mt-2">
        <h3 className="h2">{t("VPN, quand ton ordinateur est éteint")}</h3>
        <p className="text-soft">{t("Colle le fichier de configuration WireGuard que ton fournisseur de VPN te donne. Tes agents sortent par lui si ton ordinateur est éteint, avant de retomber sur le serveur.")}</p>
        {vpn.configure && (
          <p data-vpn-etat>
            {vpn.fournisseur === "surfshark" ? t("Un VPN Surfshark est enregistré avec ta clé : colle un fichier pour le remplacer.") : t("Un VPN est enregistré.")}
            {ETATS_VPN[vpn.etat]() && ` ${ETATS_VPN[vpn.etat]()}`}
            {vpn.adresse ? ` ${t("Les sites te voient comme")} ${vpn.adresse}${vpn.lieu ? ` (${vpn.lieu})` : ""}.` : ""}
          </p>
        )}
        <Label>{t("Fichier de configuration WireGuard")}
          <Textarea rows={8} spellCheck={false} autoComplete="off" value={conf} placeholder={"[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …"} onChange={(e) => setConf(e.target.value)} />
        </Label>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !conf.trim()} onClick={() => run(() => send("/api/sortie/vpn", { conf }, "PUT"))}>{t("Enregistrer")}</Button>
          {vpn.configure && <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(t("Retirer ce VPN ?")) && run(() => del("/api/sortie/vpn"))}>{t("Retirer")}</Button>}
        </div>
      </section>
    </details>
  );
}
