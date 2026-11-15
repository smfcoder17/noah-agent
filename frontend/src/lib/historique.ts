/**
 * ↑ et ↓ dans la saisie, comme dans un terminal : on parcourt ses messages déjà envoyés, du plus récent au plus ancien.
 * Seulement quand le curseur est sur la première ligne (↑) ou la dernière (↓) : au milieu d'un texte de plusieurs lignes, les flèches
 * déplacent le curseur comme d'habitude. Le brouillon en cours revient quand on redescend au bout.
 */
export function historyStep(sent: string[], index: number, draft: string, key: "ArrowUp" | "ArrowDown"): { index: number; text: string } | null {
  if (key === "ArrowUp") {
    if (index + 1 >= sent.length) return null;
    return { index: index + 1, text: sent[sent.length - 1 - (index + 1)] };
  }
  if (index < 0) return null;
  return index - 1 < 0 ? { index: -1, text: draft } : { index: index - 1, text: sent[sent.length - 1 - (index - 1)] };
}
