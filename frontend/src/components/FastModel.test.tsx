import { describe, expect, it } from "vitest";
import { fastLine } from "./FastModel";

describe("ligne du modèle rapide", () => {
  it("montre le modèle et sa mesure", () => {
    expect(fastLine({ modele: "vif-small", ms: 420, en_cours: false, mesure: true })).toBe("vif-small, premier mot en 420 ms");
  });
  it("dit quand rien n'a répondu juste, et quand rien n'est mesuré", () => {
    expect(fastLine({ modele: "", ms: null, en_cours: false, mesure: true })).toContain("garde son modèle de secours");
    expect(fastLine({ modele: "", ms: null, en_cours: false, mesure: false })).toBe("Pas encore mesuré.");
  });
});
