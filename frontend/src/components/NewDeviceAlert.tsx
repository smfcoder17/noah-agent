// Alerte à chaque nouvel appareil du compte : un accès volé doit se voir, même sans notifications activées. Compare la liste
// des appareils à ce que ce navigateur a déjà vu (les dates viennent toutes du serveur, l'horloge d'ici n'y est pour rien).
import { useCallback, useEffect, useState } from "react";
import { del, get } from "@/lib/api";
import { Button } from "./ui";

const SEEN = "noah:appareils-vus";

type Device = { id: string; nom: string; ip: string; depuis: string | null; actuel: boolean };

export function NewDeviceAlert() {
  const [fresh, setFresh] = useState<Device[]>([]);
  const [newest, setNewest] = useState("");

  const load = useCallback(async () => {
    const { appareils } = await get<{ appareils: Device[] }>("/api/devices");
    const latest = appareils.reduce((max, d) => (d.depuis && d.depuis > max ? d.depuis : max), "");
    const seen = localStorage.getItem(SEEN);
    if (!seen) return localStorage.setItem(SEEN, latest); // premier passage ici : rien à comparer
    setNewest(latest);
    setFresh(appareils.filter((d) => !d.actuel && d.depuis && d.depuis > seen));
  }, []);

  useEffect(() => {
    const check = () => {
      if (!document.hidden) load().catch(() => {});
    };
    check();
    const t = setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [load]);

  if (!fresh.length) return null;
  const device = fresh[0];
  const accept = () => {
    localStorage.setItem(SEEN, newest);
    setFresh([]);
  };
  const disconnect = () => del(`/api/devices/${device.id}`).then(load).catch(() => {});
  return (
    <div role="alert" className="fixed right-4 bottom-4 z-40 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-4 shadow-lg">
      <p className="text-sm font-semibold">Nouvel appareil sur ton compte</p>
      <p className="text-sm"><b>{device.nom || "Appareil"}</b>{device.ip ? ` · adresse ${device.ip}` : ""}{fresh.length > 1 ? ` · et ${fresh.length - 1} autre(s)` : ""}</p>
      <p className="text-xs text-muted-foreground">Ce n'est pas toi ? Déconnecte-le, puis change ton mot de passe.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="text-danger" onClick={disconnect}>Déconnecter</Button>
        <Button size="sm" onClick={accept}>C'est moi</Button>
      </div>
    </div>
  );
}
