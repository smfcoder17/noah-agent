import { t } from "@/i18n";

/** Durée d'une demande d'appairage en français simple : « il y a 3 min », « à l'instant » ; ou, restante, « 17 min ». */
export function minutes(seconds: number, left = false) {
  const m = Math.floor(seconds / 60);
  if (left) return m < 1 ? t("moins d'une minute") : t("{n} min", { n: m });
  return m < 1 ? t("à l'instant") : t("il y a {n} min", { n: m });
}
