import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const base = {
  phase: "relais_actif", active: "maison", lanceur: true, bascules: [],
  relais: { voulu: true, connecte: true, nom: "PC-de-Franck", adresse: "203.0.113.7", lieu: "Montréal, Québec" },
  vpn: { configure: false, fournisseur: "", etat: "non_configure", adresse: "", lieu: "", ville: "" },
  serveur: { adresse: "198.51.100.2" },
};
let resume: Record<string, unknown> = base;
const sent: [string, unknown, string | undefined][] = [];
const supprimes: string[] = [];
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  get: vi.fn(async () => resume),
  send: vi.fn(async (p: string, b: unknown, m?: string) => { sent.push([p, b, m]); return {}; }),
  del: vi.fn(async (p: string) => { supprimes.push(p); return {}; }),
}));
import { Sortie } from "./Sortie";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  sent.length = 0;
  supprimes.length = 0;
  resume = base;
  delete (window as { noahDesktop?: unknown }).noahDesktop;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const etat = () => host.querySelector("[data-sortie-etat]")?.textContent;

it("dit où sortent les agents, en mots simples, selon la phase", async () => {
  await act(async () => root.render(<Sortie />));
  expect(etat()).toBe("Tes agents sortent par ton ordinateur (PC-de-Franck), à Montréal, Québec");
  resume = { ...base, phase: "relais_eteint", active: "direct", relais: { ...base.relais, connecte: false } };
  await act(async () => { root.render(<div />); });
  await act(async () => root.render(<Sortie />));
  expect(etat()).toBe("Ton ordinateur est éteint : ils sortent par le serveur");
  resume = { ...base, phase: "relais_eteint", active: "vpn", relais: { ...base.relais, connecte: false } };
  await act(async () => { root.render(<div />); });
  await act(async () => root.render(<Sortie />));
  expect(etat()).toBe("Ton ordinateur est éteint : ils sortent par ton VPN");
  expect(host.textContent).not.toMatch(/Tailscale|WebSocket|proxy/i);
});

it("sans l'app de bureau et sans relais : invite à installer l'app, avec le lien, et dit où allumer l'interrupteur", async () => {
  resume = { ...base, phase: "sans_relais", active: "direct", relais: { ...base.relais, voulu: false, connecte: false, nom: "" } };
  await act(async () => root.render(<Sortie />));
  expect(etat()).toBe("Installe l'app Noah sur ton ordinateur pour les faire sortir de chez toi");
  expect(host.querySelector<HTMLAnchorElement>("a[href='https://github.com/smfcoder17/noah-agent/releases/latest']")).toBeTruthy();
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.querySelector("[data-sortie-aide]")?.textContent).toContain("Mes agents sortent par cet ordinateur");
});

it("dans l'app de bureau : l'interrupteur allume et éteint le relais de cet ordinateur", async () => {
  resume = { ...base, phase: "sans_relais", active: "direct", relais: { ...base.relais, voulu: false, connecte: false, nom: "" } };
  const relaisActiver = vi.fn(async (on: boolean) => ({ voulu: on, etat: on ? "connexion" : "arret", connexions: 0, nom: "PC-de-Franck" }));
  window.noahDesktop = {
    pickFolder: async () => null, openPath: async () => {},
    relais: async () => ({ voulu: false, etat: "arret", connexions: 0, nom: "PC-de-Franck" }), relaisActiver,
  } as never;
  await act(async () => root.render(<Sortie />));
  expect(etat()).toBe("Tes agents sortent par le serveur");
  const sw = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Mes agents sortent par cet ordinateur"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("a[href*='releases']")).toBeNull();
  await act(async () => sw.click());
  expect(relaisActiver).toHaveBeenCalledWith(true);
  expect(host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
});

it("le VPN est sous « Avancé », fermé par défaut ; le fichier collé part scellé et ne revient jamais", async () => {
  resume = { ...base, vpn: { configure: true, fournisseur: "custom", etat: "pret", adresse: "", lieu: "", ville: "" } };
  await act(async () => root.render(<Sortie />));
  const avance = host.querySelector<HTMLDetailsElement>("details[data-sortie-avance]")!;
  expect(avance.open).toBe(false);
  expect(avance.querySelector("summary")?.textContent).toBe("Avancé");
  expect(avance.textContent).toContain("Un VPN est enregistré.");
  const champ = avance.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(champ.value).toBe("");
  const enregistrer = [...avance.querySelectorAll("button")].find((b) => b.textContent === "Enregistrer")!;
  expect(enregistrer.disabled).toBe(true);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(champ, "[Interface]\nPrivateKey = x"); champ.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...avance.querySelectorAll("button")].find((b) => b.textContent === "Enregistrer")!.click());
  expect(sent).toEqual([["/api/sortie/vpn", { conf: "[Interface]\nPrivateKey = x" }, "PUT"]]);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Retirer")!.click());
  expect(supprimes).toEqual(["/api/sortie/vpn"]);
});

it("un VPN Surfshark enregistré avec sa clé le dit, sans montrer de clé", async () => {
  resume = { ...base, vpn: { configure: true, fournisseur: "surfshark", etat: "actif", adresse: "192.0.2.9", lieu: "Montréal", ville: "Montreal" } };
  await act(async () => root.render(<Sortie />));
  const texte = host.querySelector("[data-vpn-etat]")!.textContent!;
  expect(texte).toContain("Surfshark");
  expect(texte).toContain("192.0.2.9");
  expect(host.querySelectorAll("input[type=password]")).toHaveLength(0);
});
