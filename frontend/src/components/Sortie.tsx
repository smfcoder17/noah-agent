// Réglages > Serveur > Sortie réseau : par où les navigateurs des agents sortent sur Internet (ta maison, un VPN, le serveur).
// Les clés se saisissent ici, partent scellées au serveur et ne reviennent jamais : les champs restent vides.
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n";
import { del, get, send } from "@/lib/api";
import { Button, ErrorText, Input, Label } from "./ui";

type Ligne = {
  id: "maison" | "vpn" | "serveur";
  titre: string;
  etat: "non_configuree" | "en_attente" | "prete" | "active" | "injoignable";
  adresse: string;
  lieu: string;
  configuree: boolean;
  noeud?: string;
  ville?: string;
  adresse_wireguard?: string;
  cle?: boolean;
};
type Resume = { lignes: Ligne[]; active: string | null; lanceur: boolean };

const ETATS: Record<Ligne["etat"], () => string> = {
  active: () => t("Active"),
  prete: () => t("Prête"),
  injoignable: () => t("Injoignable"),
  en_attente: () => t("En attente"),
  non_configuree: () => t("Non configurée"),
};
const TITRES: Record<Ligne["id"], () => string> = { maison: () => t("Maison"), vpn: () => t("VPN"), serveur: () => t("Serveur") };

export function Sortie() {
  const [s, setS] = useState<Resume | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => get<Resume>("/api/sortie").then(setS).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const by = (id: Ligne["id"]) => s?.lignes.find((l) => l.id === id);
  if (!s) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>;
  return (
    <div className="flex flex-col gap-4 text-sm" data-sortie>
      <p className="text-soft">{t("Le navigateur de chaque agent sort sur Internet par la meilleure voie : ta maison d'abord, puis le VPN, puis le serveur lui-même. Si une voie tombe, la suivante prend le relais sans coupure.")}</p>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="list">
        {s.lignes.map((l) => (
          <div key={l.id} className="row wrap">
            <span className="grow flex min-w-0 flex-col">
              <span className="row-title">{TITRES[l.id]()}</span>
              <span className="row-sub">{l.adresse ? `${t("Les sites te voient comme")} ${l.adresse}${l.lieu ? ` (${l.lieu})` : ""}` : t("Adresse pas encore connue")}</span>
            </span>
            <span className={l.etat === "active" ? "pill work" : "pill"}>{ETATS[l.etat]()}</span>
          </div>
        ))}
      </div>
      <p className="note">{t("Les navigateurs déjà ouverts changent de voie à leur prochain réveil, jamais en pleine session.")}</p>
      <Maison ligne={by("maison")} onDone={load} onError={setError} />
      <Vpn ligne={by("vpn")} onDone={load} onError={setError} />
    </div>
  );
}

type Props = { ligne?: Ligne; onDone: () => void; onError: (m: string) => void };

function useSave(path: string, id: string, onDone: () => void, onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (body: unknown | null) => {
    setBusy(true);
    onError("");
    try {
      if (body === null) await del(`/api/sortie/${id}`);
      else await send(path, body, "PUT");
      onDone();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function Maison({ ligne, onDone, onError }: Props) {
  const [cle, setCle] = useState("");
  const [noeud, setNoeud] = useState("");
  useEffect(() => setNoeud(ligne?.noeud ?? ""), [ligne?.noeud]);
  const { busy, run } = useSave("/api/sortie/maison", "maison", onDone, onError);
  return (
    <section className="stack g8">
      <h3 className="h2">{t("Maison : ton ordinateur à Montréal")}</h3>
      <ol className="list-decimal pl-5 text-soft">
        <li>{t("Installe Tailscale sur ton ordinateur Windows et connecte-toi.")}</li>
        <li>{t("Dans Tailscale, ouvre le menu de l'icône puis « Exit node » > « Run as exit node ».")}</li>
        <li>{t("Sur le site d'administration de Tailscale, ouvre les réglages de cet ordinateur et accepte-le comme sortie.")}</li>
        <li>{t("Dans les clés de Tailscale, crée une clé d'authentification et colle-la ci-dessous avec le nom de l'ordinateur.")}</li>
      </ol>
      <Label>{t("Clé d'authentification Tailscale")}
        <Input type="password" autoComplete="off" value={cle} placeholder={ligne?.cle ? t("Clé enregistrée : laisse vide pour la garder") : "tskey-auth-…"} onChange={(e) => setCle(e.target.value)} />
      </Label>
      <Label>{t("Nom de l'ordinateur dans Tailscale")}
        <Input value={noeud} onChange={(e) => setNoeud(e.target.value)} />
      </Label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={async () => { if (await run({ cle, noeud })) setCle(""); }}>{t("Enregistrer")}</Button>
        {ligne?.configuree && <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(t("Retirer cette voie ?")) && run(null)}>{t("Retirer")}</Button>}
      </div>
    </section>
  );
}

function Vpn({ ligne, onDone, onError }: Props) {
  const [cle, setCle] = useState("");
  const [adresse, setAdresse] = useState("");
  const [ville, setVille] = useState("");
  useEffect(() => {
    setAdresse(ligne?.adresse_wireguard ?? "");
    setVille(ligne?.ville ?? "");
  }, [ligne?.adresse_wireguard, ligne?.ville]);
  const { busy, run } = useSave("/api/sortie/vpn", "vpn", onDone, onError);
  return (
    <section className="stack g8">
      <h3 className="h2">{t("VPN : Surfshark")}</h3>
      <p className="text-soft">{t("Dans ton compte Surfshark, crée une configuration WireGuard manuelle : copie sa clé privée et, si elle est donnée, son adresse.")}</p>
      <Label>{t("Clé privée WireGuard")}
        <Input type="password" autoComplete="off" value={cle} placeholder={ligne?.cle ? t("Clé enregistrée : laisse vide pour la garder") : ""} onChange={(e) => setCle(e.target.value)} />
      </Label>
      <Label>{t("Adresse WireGuard (facultatif)")}
        <Input value={adresse} onChange={(e) => setAdresse(e.target.value)} />
      </Label>
      <Label>{t("Ville de sortie")}
        <Input value={ville} placeholder={t("Montreal")} onChange={(e) => setVille(e.target.value)} />
      </Label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={async () => { if (await run({ cle_privee: cle, adresse, ville })) setCle(""); }}>{t("Enregistrer")}</Button>
        {ligne?.configuree && <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(t("Retirer cette voie ?")) && run(null)}>{t("Retirer")}</Button>}
      </div>
    </section>
  );
}
