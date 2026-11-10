import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SensitiveText } from "./SensitiveText";
it("ne met la vraie valeur dans le DOM qu'après le toucher et la recache", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<SensitiveText text="marc@gmail.com" />));
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("marc@gmail.com");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  await act(async () => root.unmount());
});
