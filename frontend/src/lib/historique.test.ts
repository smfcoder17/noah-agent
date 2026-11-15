import { describe, expect, it } from "vitest";
import { historyStep } from "./historique";

const sent = ["premier", "deuxième", "dernier"];

describe("↑ et ↓ dans la saisie", () => {
  it("↑ remonte du plus récent au plus ancien, puis s'arrête", () => {
    let s = historyStep(sent, -1, "brouillon", "ArrowUp")!;
    expect(s).toEqual({ index: 0, text: "dernier" });
    s = historyStep(sent, s.index, "brouillon", "ArrowUp")!;
    expect(s.text).toBe("deuxième");
    s = historyStep(sent, s.index, "brouillon", "ArrowUp")!;
    expect(s.text).toBe("premier");
    expect(historyStep(sent, s.index, "brouillon", "ArrowUp")).toBeNull();
  });
  it("↓ redescend, puis rend le brouillon en cours", () => {
    expect(historyStep(sent, 1, "brouillon", "ArrowDown")).toEqual({ index: 0, text: "dernier" });
    expect(historyStep(sent, 0, "brouillon", "ArrowDown")).toEqual({ index: -1, text: "brouillon" });
    expect(historyStep(sent, -1, "brouillon", "ArrowDown")).toBeNull();
  });
  it("sans message envoyé, les flèches gardent leur rôle", () => {
    expect(historyStep([], -1, "", "ArrowUp")).toBeNull();
  });
});
