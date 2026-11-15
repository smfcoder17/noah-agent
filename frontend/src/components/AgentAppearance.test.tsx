import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Agent } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), send: vi.fn(async () => ({})) }));
vi.mock("./AgentPowers", () => ({ Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock("./ui", () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => { const { variant: _v, size: _s, ...rest } = p; return <button {...rest} />; },
  ErrorText: () => null,
}));
import { send } from "@/lib/api";
import { AgentAppearance } from "./AgentAppearance";

it("point 4 : Apparence propose toutes les formes, montre celle de l'agent et enregistre le choix", async () => {
  const agent = { id: "a1", name: "Léa", color: "#4a9df8", shape: "bulle", detail: "" } as Agent;
  const changed = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentAppearance agent={agent} onChanged={changed} />));
  const shapes = [...host.querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].filter((b) => ["Gomme", "Bulle", "Cube", "Goutte", "Pastille"].includes(b.textContent!));
  expect(shapes.map((b) => b.textContent)).toEqual(["Gomme", "Bulle", "Cube", "Goutte", "Pastille"]);
  expect(shapes.find((b) => b.getAttribute("aria-pressed") === "true")!.textContent).toBe("Bulle");
  expect(host.querySelector("svg[data-shape]")!.getAttribute("data-shape")).toBe("bulle");
  await act(async () => shapes[3].click());
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Enregistrer")!.click());
  expect(send).toHaveBeenCalledWith("/api/agents/a1/look", { shape: "goutte" }, "PATCH");
  expect(changed).toHaveBeenCalled();
  await act(async () => root.unmount());
});
