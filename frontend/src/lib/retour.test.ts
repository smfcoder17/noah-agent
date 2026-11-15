import { describe, expect, it } from "vitest";
import { returnMoment } from "./retour";

const H = 3_600_000;
const now = 100 * H;

describe("cartes du retour", () => {
  it("rien tant que la conversation est récente et que l'agent ne fait que répondre", () => {
    expect(returnMoment(now - H, now - H + 30_000, now)).toBe("");
  });
  it("après trois heures sans un mot, on propose ce qu'il a fait depuis le dernier message", () => {
    expect(returnMoment(now - 4 * H, now - 4 * H + 60_000, now)).toBe("dernier");
  });
  it("le lendemain, on propose ce qu'il a fait depuis hier", () => {
    expect(returnMoment(now - 20 * H, now - 19 * H, now)).toBe("hier");
  });
  it("l'agent a parlé de lui-même (une routine) : les cartes viennent tout de suite", () => {
    expect(returnMoment(now - H, now - 5 * 60_000, now)).toBe("dernier");
  });
  it("rien si le dernier message est celui de la personne", () => {
    expect(returnMoment(now - 5 * H, null, now)).toBe("");
  });
});
