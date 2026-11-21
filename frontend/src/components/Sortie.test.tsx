import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const resume = {
  active: "maison", lanceur: true,
  lignes: [
    { id: "maison", titre: "Maison", etat: "active", adresse: "203.0.113.7", lieu: "Montréal", configuree: true, noeud: "mon-pc", cle: true },
    { id: "vpn", titre: "VPN", etat: "injoignable", adresse: "", lieu: "", configuree: true, ville: "Montreal", adresse_wireguard: "", cle: true },
    { id: "serveur", titre: "Serveur", etat: "prete", adresse: "198.51.100.2", lieu: "", configuree: true },
  ],
};
const sent: [string, unknown, string | undefined][] = [];
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  get: vi.fn(async () => resume),
  send: vi.fn(async (p: string, b: unknown, m?: string) => { sent.push([p, b, m]); return {}; }),
  del: vi.fn(async () => ({})),
}));
import { Sortie } from "./Sortie";

let host: HTMLDivElement, root: Root;
beforeEach(() => { sent.length = 0; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("montre les trois voies avec leur état et l'adresse vue par les sites", async () => {
  await act(async () => root.render(<Sortie />));
  const rows = [...host.querySelectorAll(".row")].map((r) => r.textContent);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain("203.0.113.7");
  expect(rows[0]).toContain("Montréal");
  expect(rows[1]).toContain("Injoignable");
  expect(rows[2]).toContain("Prête");
});

it("ne montre jamais une clé enregistrée et n'en renvoie pas : champs vides, envoi vide", async () => {
  await act(async () => root.render(<Sortie />));
  const secrets = [...host.querySelectorAll<HTMLInputElement>("input[type=password]")];
  expect(secrets).toHaveLength(2);
  for (const i of secrets) expect(i.value).toBe("");
  expect(host.textContent).not.toMatch(/tskey-/);
  const save = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Enregistrer")[0];
  await act(async () => save.click());
  expect(sent[0]).toEqual(["/api/sortie/maison", { cle: "", noeud: "mon-pc" }, "PUT"]);
});
