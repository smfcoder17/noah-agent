import { expect, it } from "vitest";
import { askAgent, takeAsk } from "./askAgent";
it("une action de carte ne part pas à un autre agent et ne part qu'une fois", () => {
  askAgent("Relire ce devis", "a");
  expect(takeAsk("b")).toBeNull();
  expect(takeAsk("a")).toBe("Relire ce devis");
  expect(takeAsk("a")).toBeNull();
});
