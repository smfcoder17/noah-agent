const HOUR = 3_600_000;

/** Quand proposer les cartes du retour : longtemps sans un mot de la personne, ou l'agent a parlé de lui-même depuis. */
export function returnMoment(lastUser: number | null, lastAgent: number | null, now: number): "" | "hier" | "dernier" {
  if (!lastAgent) return "";
  const gone = lastUser ? now - lastUser : Infinity;
  const onItsOwn = lastUser !== null && lastAgent - lastUser > 10 * 60_000; // une routine, un rappel, un compte rendu
  if (gone < 3 * HOUR && !onItsOwn) return "";
  return gone > 18 * HOUR ? "hier" : "dernier";
}
