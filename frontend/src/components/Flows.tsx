// Confidentialité (G7.4) : tout ce qui sort du serveur, et vers où. Le fournisseur de chaque agent d'abord.
import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { get } from "@/lib/api";
import { ErrorText } from "./ui";

type Flow = { quoi: string; vers: string; quand: string; detail?: string; agent?: string; local?: boolean };

export function Flows() {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get<{ flux: Flow[] }>("/api/flux")
      .then((r) => setFlows(r.flux))
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!flows) return <p className="text-sm text-muted-foreground">{t("Chargement…")}</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t("Tout ce que ce serveur envoie hors de chez toi, et vers où. Aucune télémétrie : rien ne part vers les développeurs de Noah.")}
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {flows.map((f, i) => (
          <li key={i} className="flex flex-col gap-0.5 px-4 py-3 text-sm sm:flex-row sm:items-baseline sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{f.quoi}</p>
              {f.detail && <p className="text-xs text-muted-foreground">{f.detail}</p>}
              <p className="text-xs text-muted-foreground">{f.quand}</p>
            </div>
            <span className={f.local ? "font-mono text-xs text-ok" : "font-mono text-xs"}>{f.vers}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
