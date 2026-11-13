import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ send: vi.fn(async () => ({ title: "Kevin Ngo (@kevin_t_ngo) on X", site: "X (formerly Twitter)", description: "", image: null, icon: null, duration: null })), get: vi.fn(async () => ({})), currentAuthEpoch: () => "t" }));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {} }));
import { LinkCard } from "./LinkCard";

it("sépare titre et site, à l'écran, pour un lecteur d'écran et au copier-coller, sans répéter le site", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<LinkCard url="https://x.com/kevin_t_ngo/status/2120656025690804594" />));
  await act(async () => {});
  const link = host.querySelector("a")!;
  expect(link.querySelector("b")?.textContent).toBe("Kevin Ngo (@kevin_t_ngo)");
  expect(link.querySelector("small")?.textContent).toBe("X (formerly Twitter)");
  expect(link.querySelector(".link-text")).not.toBeNull();
  expect(link.textContent).toBe("Kevin Ngo (@kevin_t_ngo) · X (formerly Twitter)");
  expect(link.getAttribute("aria-label")).toBe("Ouvrir Kevin Ngo (@kevin_t_ngo), X (formerly Twitter)");
  await act(async () => root.unmount());
});
