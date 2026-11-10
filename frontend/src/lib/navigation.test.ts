import { expect, it } from "vitest";
import { initialNavigation, navigate } from "./navigation";
it("revient page par page et ne garde aucune ancienne porte après un changement d'onglet", () => {
  let nav = navigate(initialNavigation, { type: "push", route: { kind: "agent" } });
  nav = navigate(nav, { type: "push", route: { kind: "settings", tab: "privacy" } });
  expect(navigate(nav, { type: "back" }).stack.slice(-1)[0]?.kind).toBe("agent");
  nav = navigate(nav, { type: "reset", route: { kind: "tab", tab: "files" } });
  expect(nav.stack).toEqual([{ kind: "tab", tab: "files" }]);
  expect(navigate(nav, { type: "back" })).toBe(nav);
});
