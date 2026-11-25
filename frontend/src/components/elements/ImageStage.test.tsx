// L'image zoomée prend sa vraie taille dans la zone qui défile : rien n'est rogné. L'ancien zoom (transform: scale dans une
// grille centrée) laissait la zone de défilement à la taille d'origine, et le haut et la gauche de l'image hors d'atteinte.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ImageStage } from "./ImageStage";

const proto = HTMLElement.prototype;
const saved = { w: Object.getOwnPropertyDescriptor(proto, "clientWidth"), h: Object.getOwnPropertyDescriptor(proto, "clientHeight") };
beforeEach(() => {
  // jsdom ne calcule pas de mise en page : l'image ajustée à la vue mesure 400 × 300.
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.tagName === "IMG" ? 400 : 600; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return this.tagName === "IMG" ? 300 : 500; } });
});
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ImageStage src="/x.png" alt="capture" onError={() => {}} />));
  const img = host.querySelector("img")!;
  await act(async () => { img.dispatchEvent(new Event("load")); });
  return { host, img, close: () => act(async () => { root.unmount(); host.remove(); }) };
}
const zoomTo = (host: HTMLElement, v: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>(".image-zoom input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const dbl = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });

afterEach(() => {
  if (saved.w) Object.defineProperty(proto, "clientWidth", saved.w);
  if (saved.h) Object.defineProperty(proto, "clientHeight", saved.h);
});

it("zoomée, l'image prend sa vraie taille au lieu d'un transform qui la rogne", async () => {
  const { host, img, close } = await mount();
  await zoomTo(host, "2");
  expect(img.style.transform).toBe("");
  expect(img.style.width).toBe("800px");
  expect(img.style.height).toBe("600px");
  expect(img.style.maxWidth).toBe("none");
  await close();
});

it("au zoom 1, l'image reprend sa taille d'ajustement ; le double-clic bascule entre 1 et 2", async () => {
  const { img, close } = await mount();
  await dbl(img);
  expect(img.style.width).toBe("800px");
  await dbl(img);
  expect(img.style.width).toBe("");
  await close();
});

it("le curseur du zoom reste hors de la zone qui défile", async () => {
  const { host, close } = await mount();
  expect(host.querySelector(".image-stage input")).toBeNull();
  expect(host.querySelector(".image-zoom input")).not.toBeNull();
  await close();
});
