// Les pastilles de la saisie (@ un agent, un fichier, un dossier ; / une compétence) : ce que la personne a choisi, gardé jusqu'à l'envoi.
// Seul ce petit morceau est du premier écran ; tout le reste (suggestions, pastilles du fil) est dans lib/mentions.ts, chargé à la demande.
export type MentionKind = "agent" | "fichier" | "dossier" | "competence";
export type Mention = { kind: MentionKind; label: string; ref: string };

const registry = new Map<string, Map<string, Mention>>();

/** Les pastilles de la saisie de cet agent : le texte affiché (« @plan.md ») → ce qu'il désigne. */
export function mentionsOf(agentId: string): Map<string, Mention> {
  let found = registry.get(agentId);
  if (!found) registry.set(agentId, (found = new Map()));
  return found;
}

export const hasMentions = (agentId: string) => (registry.get(agentId)?.size ?? 0) > 0;

/** Le message contient des pastilles déjà écrites en lien `noah:`. */
export const hasTokens = (text: string) => text.includes("](noah:");

/** Une pastille écrite dans un message (même forme que server/noah/mentions.py). */
export const TOKEN = /\[([@/])([^\]\n]{1,200})\]\(noah:(agent|fichier|dossier|competence)\/([^)\s]{1,600})\)/g;

/** Le message sans lien : « @plan.md ». Pour retaper un message envoyé. */
export const lisible = (text: string) => (hasTokens(text) ? text.replace(TOKEN, (_, mark: string, label: string) => mark + label) : text);
