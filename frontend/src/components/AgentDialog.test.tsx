import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const PRESETS = {
  version: 1,
  defaut: { demandes: ["Général 1", "Général 2", "Général 3", "Général 4"] },
  agents: { "veille-ab12": "veille" },
  presets: [
    { id: "veille", nom: "Veille", accroche: "Suit tes sujets.", couleur: "#4a9df8", shape: "bulle", detail: "antenne", role: "Tu suis l'actualité de mes sujets.", demandes: ["V1", "V2", "V3", "V4"], routines: [{ nom: "Matin", quand: "every day at 8am", consigne: "Résume." }], connexions: [] },
  ],
};

vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => PRESETS),
  send: vi.fn(),
  del: vi.fn(),
}));
vi.mock("./Voice", () => ({ DictateButton: () => null, NO_AGENT: "", useCanDictate: () => false, useFieldDictation: () => ({ state: "idle" }) }));
vi.mock("./ui", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = p;
    return <button {...rest} />;
  },
  ErrorText: ({ children }: { children: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null),
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Textarea: (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} />,
}));

import { del, send } from "@/lib/api";
import { demandesFor } from "@/lib/presets";
import type { Agent } from "@/lib/api";
import { AgentDialog } from "./AgentDialog";

beforeEach(() => {
  vi.mocked(send).mockReset();
  vi.mocked(del).mockReset();
});

const render = async (agent: Agent | null, onSaved = vi.fn(), onDeleted = vi.fn()) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentDialog open agent={agent} onOpenChange={() => {}} onSaved={onSaved} onDeleted={onDeleted} />));
  return { host, root, onSaved, onDeleted };
};
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

it("un modèle pré-remplit nom et rôle, et la création porte son identifiant", async () => {
  vi.mocked(send).mockResolvedValue({ id: "veille-ab12" });
  const { host, root, onSaved } = await render(null);
  expect(button(host, "Partir de zéro")).toBeTruthy();
  await act(async () => button(host, "Veille").click());
  expect(host.querySelector("input")!.value).toBe("Veille");
  expect(host.querySelector("textarea")!.value).toBe("Tu suis l'actualité de mes sujets.");
  await act(async () => button(host, "Créer l'agent").click());
  expect(send).toHaveBeenCalledWith("/api/agents", { name: "Veille", role: "Tu suis l'actualité de mes sujets.", preset: "veille" });
  // La couleur du modèle est posée par le serveur : pas de second appel.
  expect(send).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith("veille-ab12");
  await act(async () => root.unmount());
});

it("un échec de la couleur après la création ne fait pas créer un deuxième agent", async () => {
  vi.mocked(send).mockImplementation(async (path: string) => {
    if (path === "/api/agents") return { id: "zero-1" };
    throw new Error("Le serveur ne répond pas.");
  });
  const { host, root, onSaved } = await render(null);
  await act(async () => button(host, "Veille").click());
  // Une autre couleur que celle du modèle : le PATCH /look part, et échoue.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Corail"]')!.click());
  await act(async () => button(host, "Créer l'agent").click());
  expect(vi.mocked(send).mock.calls.filter(([p]) => p === "/api/agents")).toHaveLength(1);
  expect(onSaved).toHaveBeenCalledWith("zero-1");
  await act(async () => root.unmount());
});

it("une suppression qui échoue le dit et rend la main", async () => {
  vi.mocked(del).mockRejectedValue(new Error("Le serveur ne répond pas."));
  const agent = { id: "a1", name: "Léa", role: "", color: "#ff7a59", droit: "proprietaire" } as Agent;
  const { host, root, onDeleted } = await render(agent);
  await act(async () => button(host, "Supprimer").click());
  await act(async () => button(host, "Confirmer la suppression").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("La suppression n'a pas abouti");
  expect(onDeleted).not.toHaveBeenCalled();
  expect(button(host, "Supprimer").disabled).toBe(false);
  await act(async () => root.unmount());
});

it("l'écran vide propose les demandes du modèle de l'agent, sinon les générales", () => {
  expect(demandesFor(PRESETS, "veille-ab12")).toEqual(["V1", "V2", "V3", "V4"]);
  expect(demandesFor(PRESETS, "autre")).toEqual(["Général 1", "Général 2", "Général 3", "Général 4"]);
  expect(demandesFor(null, "autre")).toEqual([]);
});
