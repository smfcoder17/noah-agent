import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { appLabel } from "@/lib/appLabel";

/** Retour d'une connexion (Notion, Linear…) : le fournisseur ramène la personne sur Noah, qui dit que c'est fait. */
export function ConnectedBanner() {
  const [name, setName] = useState(() => location.hash.match(/^#connexion=([a-z0-9-]{1,40})$/)?.[1] ?? "");
  useEffect(() => {
    if (!name) return;
    history.replaceState(null, "", location.pathname + location.search);
    const later = setTimeout(() => setName(""), 6000);
    return () => clearTimeout(later);
  }, [name]);
  if (!name) return null;
  return (
    <div role="status" className="fixed left-1/2 top-14 z-50 max-w-[calc(100vw-2rem)] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-lg">
      <Check className="size-4 text-ok" />
      {appLabel(name)} est connecté
    </div>
  );
}
