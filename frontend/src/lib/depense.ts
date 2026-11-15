// C5 : une dépense dont une part vient d'un modèle sans prix connu ne s'affiche jamais « 0 $ ».
// Le serveur compte ces appels dans « sans_prix » (main.py, /api/usage) : des jetons sans coût, hors modèle gratuit.
import { t } from "@/i18n";
import { money } from "./utils";

export function spentLabel(cost: number | null | undefined, unpriced?: number | null): string {
  const value = cost ?? 0;
  if (!unpriced) return t("{montant} $", { montant: money(value) });
  return value > 0 ? t("{montant} $ + prix inconnu", { montant: money(value) }) : t("prix inconnu");
}
