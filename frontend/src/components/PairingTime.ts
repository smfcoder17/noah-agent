/** Durée d'une demande d'appairage en français simple : « il y a 3 min », « à l'instant » ; ou, restante, « 17 min ». */
export function minutes(seconds: number, left = false) {
  const m = Math.floor(seconds / 60);
  if (left) return m < 1 ? "moins d'une minute" : `${m} min`;
  return m < 1 ? "à l'instant" : `il y a ${m} min`;
}
