// Dictionnaire anglais : un fichier par partie de l'interface (« texte français » → "English text").
// Chaque fichier exporte par défaut un objet ; ils sont réunis ici. Une même clé dans deux fichiers doit avoir la même
// traduction (vérifié par i18n.test.ts).
const parties = import.meta.glob<{ default: Record<string, string> }>(["./*.ts", "!./index.ts"], { eager: true });

export const PARTIES: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(parties).map(([chemin, m]) => [chemin, m.default]),
);
export const en: Record<string, string> = Object.assign({}, ...Object.values(PARTIES));
