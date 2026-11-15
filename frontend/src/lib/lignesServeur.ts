// Lignes que le serveur écrit en base, en français (Activité, début d'une réponse) : traduites ici à l'affichage, comme « Bloqué : ».
// Un texte qui ne suit pas exactement leur forme reste tel quel.
import { locale, t } from "@/i18n";

const PC_OFF = /^_Ton ordinateur est éteint : réponse par (.+?)\._(\n|$)/;
const SUBSCRIPTION_TURN = /^([\d\s  ]+) jetons · (\d+(?:,\d+)?) s · compris dans l'abonnement$/;

/** relay.turn_notes, posé en italique au début de la réponse quand le secours a répondu à la place de l'ordinateur. */
export function pcNote(text: string): string {
  return text.replace(PC_OFF, (_m, by: string, end: string) => `_${t("Ton ordinateur est éteint : réponse par {fournisseur}.", { fournisseur: by })}_${end}`);
}

/** Titre d'une ligne d'Activité (juge.py) : refus, accord demandé, geste autorisé sur une citation (C1). */
export function activityTitle(title: string): string {
  return title
    .replace(/^Ton juge a refusé : /, t("Bloqué : "))
    .replace(/^Ton juge demande ton accord : .*/, t("Accord demandé"))
    .replace(/^Autorisé sur tes mots : /, t("Autorisé sur tes mots : "));
}

/** Résultat d'une ligne d'Activité : un tour du cerveau par un abonnement (relay._journal_turn). */
export function activityResult(result: string): string {
  const m = SUBSCRIPTION_TURN.exec(result);
  if (!m) return result;
  const tokens = Number(m[1].replace(/\D/g, "")).toLocaleString(locale());
  const seconds = Number(m[2].replace(",", ".")).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return t("{n} jetons · {s} s · compris dans l'abonnement", { n: tokens, s: seconds });
}
