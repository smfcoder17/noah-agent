import { expect, it } from "vitest";
import { initialNavigation, navigate, type Navigation, type Route } from "./navigation";
it("revient page par page et ne garde aucune ancienne porte après un changement d'onglet", () => {
  let nav = navigate(initialNavigation, { type: "push", route: { kind: "agent" } });
  nav = navigate(nav, { type: "push", route: { kind: "settings", tab: "privacy" } });
  expect(navigate(nav, { type: "back" }).stack.slice(-1)[0]?.kind).toBe("agent");
  nav = navigate(nav, { type: "reset", route: { kind: "tab", tab: "files" } });
  expect(nav.stack).toEqual([{ kind: "tab", tab: "files" }]);
  expect(navigate(nav, { type: "back" })).toBe(nav);
});

it("une seule page à la fois : Pour toi, Activité, Recherche et Réglages se remplacent, une discussion ou un panneau les ferme", () => {
  const pages: Route[] = [{ kind: "page", page: "inbox" }, { kind: "page", page: "activite" }, { kind: "page", page: "recherche" }, { kind: "settings", tab: "home" }];
  const ouvertes = (n: Navigation) => n.stack.filter((r) => r.kind === "page" || r.kind === "settings");
  for (const a of pages) for (const b of pages) {
    const nav = navigate(navigate(initialNavigation, { type: "push", route: a }), { type: "push", route: b });
    expect(ouvertes(nav), `${JSON.stringify(a)} puis ${JSON.stringify(b)}`).toEqual([b]);
  }
  for (const a of pages) for (const route of [{ kind: "thread", id: "c1" }, { kind: "panel", tab: "files" }] as Route[]) {
    const nav = navigate(navigate(initialNavigation, { type: "push", route: a }), { type: "push", route });
    expect(ouvertes(nav)).toEqual([]);
    expect(nav.stack.slice(-1)[0]).toEqual(route);
  }
  // Ce qui n'est pas une page reste : le panneau et le tiroir ne ferment pas la page, la discussion de l'agent (reset) ferme tout.
  const avecPanneau = navigate(navigate(initialNavigation, { type: "push", route: { kind: "panel", tab: "files" } }), { type: "push", route: pages[0] });
  expect(avecPanneau.stack.map((r) => r.kind)).toEqual(["tab", "panel", "page"]);
  expect(navigate(avecPanneau, { type: "reset", route: { kind: "tab", tab: "chat" } }).stack).toEqual([{ kind: "tab", tab: "chat" }]);
});
