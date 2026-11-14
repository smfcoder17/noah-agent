// Le contenu d'un signalement de réponse (voir components/ReportAnswer) : motifs proposés et e-mail à l'éditeur.
import { EDITEUR_EMAIL } from "./editeur";
import { t } from "@/i18n";

export const MOTIFS = [
  t("Offensant, haineux ou harcelant"),
  t("Dangereux ou illégal"),
  t("Sexuel ou choquant"),
  t("Faux ou trompeur"),
  t("Autre"),
];

const EXTRAIT_MAX = 1200; // un lien mailto trop long est coupé par certaines apps de messagerie
export const COMMENTAIRE_MAX = 1000;

/** Le lien de l'e-mail : motif, commentaire et extrait de la réponse, à relire dans l'app de messagerie avant l'envoi. */
export function reportMailto(motif: string, commentaire: string, reponse: string, quand = new Date()): string {
  const extrait = reponse.length > EXTRAIT_MAX ? `${reponse.slice(0, EXTRAIT_MAX)}…` : reponse;
  const body = [
    t("Motif : {motif}", { motif }),
    commentaire.trim() ? t("Commentaire : {commentaire}", { commentaire: commentaire.trim() }) : "",
    t("Date : {date}", { date: quand.toISOString() }),
    "",
    t("Réponse signalée :"),
    extrait,
  ].filter((line, i) => line || i > 2).join("\n");
  return `mailto:${EDITEUR_EMAIL}?subject=${encodeURIComponent(t("Signalement d'une réponse de Noah : {motif}", { motif }))}&body=${encodeURIComponent(body)}`;
}
