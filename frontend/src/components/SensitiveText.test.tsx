import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SensitiveLink, SensitiveText } from "./SensitiveText";
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
it("garde cliquable le lien d'un post X dont l'identifiant passe Luhn, et masque un mailto:", async () => {
  const url = "https://x.com/SmfCoder/status/2120656025690804594";
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<><SensitiveLink href={url}>{url}</SensitiveLink><SensitiveLink href="mailto:marc@gmail.com">marc@gmail.com</SensitiveLink></>));
  expect(host.querySelector(`a[href="${url}"]`)?.textContent).toBe(url);
  expect(host.textContent).toContain("Révéler le lien");
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  await act(async () => root.unmount());
});
