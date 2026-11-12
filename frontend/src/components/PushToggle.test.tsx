import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { PushToggle } from "./PushToggle";

afterEach(() => { delete (window as { noahDesktop?: unknown }).noahDesktop; });

it("dans l'app de bureau, pas d'impasse Web Push : les notifications passent par l'app", async () => {
  (window as { noahDesktop?: unknown }).noahDesktop = { forgetServer: async () => {}, version: "0.1.8" };
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<PushToggle />));
  expect(host.textContent).toContain("passent par l'app de bureau");
  expect(host.querySelector("button")).toBeNull();
  await act(async () => root.unmount());
});
