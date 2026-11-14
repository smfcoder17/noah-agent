// Le contenu d'un signalement de réponse (voir components/ReportAnswer) : motifs proposés et e-mail à l'éditeur.
import { EDITEUR_EMAIL } from "./editeur";

export const MOTIFS = [
  "Offensant, haineux ou harcelant",
  "Dangereux ou illégal",
  "Sexuel ou choquant",
  "Faux ou trompeur",
  "Autre",
] as const;

const EXTRAIT_MAX = 1200; // un lien mailto trop long est coupé par certaines apps de messagerie
export const COMMENTAIRE_MAX = 1000;

/** Le lien de l'e-mail : motif, commentaire et extrait de la réponse, à relire dans l'app de messagerie avant l'envoi. */
export function reportMailto(motif: string, commentaire: string, reponse: string, quand = new Date()): string {
  const extrait = reponse.length > EXTRAIT_MAX ? `${reponse.slice(0, EXTRAIT_MAX)}…` : reponse;
  const body = [
    `Motif : ${motif}`,
    commentaire.trim() ? `Commentaire : ${commentaire.trim()}` : "",
    `Date : ${quand.toISOString()}`,
    "",
    "Réponse signalée :",
    extrait,
  ].filter((line, i) => line || i > 2).join("\n");
  return `mailto:${EDITEUR_EMAIL}?subject=${encodeURIComponent(`Signalement d'une réponse de Noah : ${motif}`)}&body=${encodeURIComponent(body)}`;
}
