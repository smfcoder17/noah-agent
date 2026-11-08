// Un nouvel appareil sur le compte : l'état vit sur le serveur, l'écran revient à chaque ouverture tant que personne n'a tranché.
// « Ce n'est pas moi » coupe cette session sans demander de preuve (server/noah/appareils.py).
import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { useProof } from "./Proof";
import { Button, ErrorText } from "./ui";

type Alert = { id: string; nom: string; type: string; ip: string; reseau_connu: boolean; date: string; peut_confirmer: boolean };

const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function NewDeviceAlert({ onChangePassword }: { onChangePassword: () => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [closed, setClosed] = useState<string[]>([]); // ne peut pas trancher d'ici : fermé pour cette ouverture seulement
  const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => get<{ alertes: Alert[] }>("/api/me/alertes-appareils").then((r) => setAlerts(r.alertes)).catch(() => {}), []);

  useEffect(() => {
    const check = () => {
      if (!document.hidden) load();
    };
    check();
    const t = setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [load]);

  const { withProof, proofDialog } = useProof();
  const decide = async (alert: Alert, decision: "moi" | "pas-moi") => {
    setBusy(true);
    setError("");
    try {
      const path = `/api/me/alertes-appareils/${alert.id}/${decision}`;
      if (decision === "pas-moi") {
        await send(path, {});
        setCut(true);
      } else await withProof(path, {}); // « C'est moi » efface l'alerte partout : le mot de passe est redemandé
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    load();
  };

  const device = alerts.find((a) => !closed.includes(a.id));
  if (!device && !cut) return null;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-black/45 p-3">
      {proofDialog}
      <div role="alertdialog" aria-labelledby="alerte-titre" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-warn bg-surface p-5 shadow-2xl">
        {cut ? (
          <>
            <h2 id="alerte-titre" className="text-lg font-semibold">Cet appareil est déconnecté</h2>
            <p className="text-sm text-muted-foreground">
              S'il a utilisé ton mot de passe, change-le maintenant.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setCut(false)}>Plus tard</Button>
              <Button onClick={() => { setCut(false); onChangePassword(); }}>Changer mon mot de passe</Button>
            </div>
          </>
        ) : device && (
          <>
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" />
              <div className="min-w-0">
                <h2 id="alerte-titre" className="text-lg font-semibold">Nouvel appareil sur ton compte</h2>
                <p className="text-sm text-muted-foreground">Il est connecté en ce moment. Est-ce bien toi&nbsp;?</p>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-muted p-3 text-sm">
              <dt className="text-muted-foreground">Appareil</dt><dd className="break-words font-medium">{device.nom || "Inconnu"}</dd>
              <dt className="text-muted-foreground">Adresse</dt><dd className="break-all">{device.ip || "Inconnue"}</dd>
              <dt className="text-muted-foreground">Réseau</dt><dd>{device.reseau_connu ? "Déjà vu sur ce compte" : "Jamais vu sur ce compte"}</dd>
              <dt className="text-muted-foreground">Date</dt><dd>{when(device.date)}</dd>
            </dl>
            {!device.peut_confirmer && (
              <p className="text-xs text-muted-foreground">Seul un appareil déjà relié peut dire « C'est moi ».</p>
            )}
            <ErrorText>{error}</ErrorText>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" className="text-danger" disabled={busy} onClick={() => decide(device, "pas-moi")}>Ce n'est pas moi</Button>
              {device.peut_confirmer
                ? <Button disabled={busy} onClick={() => decide(device, "moi")}>C'est moi</Button>
                : <Button variant="outline" onClick={() => setClosed((c) => [...c, device.id])}>Fermer</Button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
