// « Noah a été mis à jour » : le serveur sert une autre interface que celle de cette page. Un bandeau propose de recharger ;
// rien ne se recharge tout seul ici, pour ne pas couper un message en cours d'écriture.
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { interfaceChangee } from "@/lib/interfaceChangee";
import { INTERFACE_CHANGEE, recharger } from "@/lib/rechargement";
import { Button } from "./ui";

const VERIFICATION = 5 * 60_000; // à intervalle, et à chaque retour sur la fenêtre
const AU_PLUS_UNE_PAR = 10_000;

export function InterfaceMiseAJour() {
  const [changee, setChangee] = useState(false);
  useEffect(() => {
    let derniere = 0;
    let arret = false;
    const verifier = async () => {
      if (Date.now() - derniere < AU_PLUS_UNE_PAR) return;
      derniere = Date.now();
      if (await interfaceChangee() && !arret) setChangee(true);
    };
    const visible = () => { if (document.visibilityState === "visible") void verifier(); };
    const retour = () => void verifier();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", retour);
    const dit = () => setChangee(true); // un morceau perdu, et un rechargement seul impossible : le bandeau le propose
    window.addEventListener(INTERFACE_CHANGEE, dit);
    const minuteur = setInterval(() => void verifier(), VERIFICATION);
    return () => { arret = true; clearInterval(minuteur); window.removeEventListener(INTERFACE_CHANGEE, dit); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", retour); };
  }, []);
  if (!changee) return null;
  return (
    <div role="status" data-interface-mise-a-jour className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-xl border bg-popover px-4 py-2 text-sm shadow-lg">
      <span>{t("Noah a été mis à jour.")}</span>
      <Button size="sm" onClick={() => recharger({ forcer: true })}>{t("Recharger")}</Button>
    </div>
  );
}
