import { expect, it } from "vitest";
import { luhn, sensitiveParts } from "./sensitive";
it("masque courriels, téléphones et cartes vérifiées par Luhn", () => {
  const parts = sensitiveParts("Marc : marc@gmail.com, +1 514 555 1242, carte 4111 1111 1111 1111.");
  expect(parts.filter((p) => p.sensitive).length).toBe(3);
  expect(parts.map((p) => p.masked).join("")).not.toContain("marc@gmail.com");
  expect(luhn("4111 1111 1111 1111")).toBe(true);
});
it("ne masque ni date, ni prix, ni identifiant qui échoue au contrôle", () => {
  expect(sensitiveParts("2026-11-10 · 1 200 $ · version 0.1.6 · 1234567890123456").every((p) => !p.sensitive)).toBe(true);
  expect(luhn("0000000000000000")).toBe(false);
});
it("sépare un téléphone d'une carte voisine, même sans virgule", () => {
  const parts = sensitiveParts("+1 514 555 1242 4111 1111 1111 1111");
  expect(parts.filter((p) => p.sensitive)).toHaveLength(2);
});
