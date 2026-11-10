import { expect, it } from "vitest";
import { viewportInset } from "./keyboard";
it("mesure le clavier sans confondre un zoom et un clavier", () => {
  expect(viewportInset(844, 544)).toBe(300);
  expect(viewportInset(844, 844)).toBe(0);
  expect(viewportInset(844, 500, 10, 2)).toBe(0);
});
