import { describe, expect, it } from "vitest";
import { APERCU_LARGEUR, CHAT_MIN, apercuSeSuperpose } from "./workPanel";

// Finitions 0.4.2 (point 7) : la discussion garde une largeur lisible ; en dessous, l'aperçu se pose par-dessus le panneau.
describe("aperçu à côté du panneau", () => {
  it("la discussion garde au moins CHAT_MIN : juste assez de place, l'aperçu se pose à côté", () => {
    expect(apercuSeSuperpose(CHAT_MIN + APERCU_LARGEUR)).toBe(false);
    expect(apercuSeSuperpose(CHAT_MIN + APERCU_LARGEUR + 300)).toBe(false);
  });
  it("un pixel de moins : l'aperçu se superpose au panneau au lieu d'écraser la discussion", () => {
    expect(apercuSeSuperpose(CHAT_MIN + APERCU_LARGEUR - 1)).toBe(true);
  });
  it("le cas de Franck : fenêtre 1300, barre de gauche 248, panneau 400 → 652 libres, l'aperçu se superpose (la discussion ne tombe pas à 70 px)", () => {
    expect(apercuSeSuperpose(1300 - 248 - 400)).toBe(true);
    expect(CHAT_MIN).toBeGreaterThanOrEqual(360);
  });
});
