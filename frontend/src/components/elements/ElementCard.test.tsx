import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const actions = vi.hoisted(() => ({ view: vi.fn(), play: vi.fn() }));
vi.mock("../Viewer", () => ({ useViewer: () => actions.view }));
vi.mock("./MediaPlayers", () => ({ useMedia: () => actions.play }));
vi.mock("@/lib/api", () => ({ request: async () => ({ body: null }), rawFileUrl: (_agent: string, path: string) => path, previewUrl: async (_agent: string, path: string) => path, mediaUrl: (_agent: string, path: string) => path, send: vi.fn(), currentAuthEpoch: () => "test", get: async () => [] }));
import { ELEMENTS, type ElementKind } from "@/lib/elements";
import { ElementCard } from "./ElementCard";
it("ouvre chaque format du registre et réserve les médias au lecteur persistant", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  for (const kind of Object.keys(ELEMENTS) as ElementKind[]) {
    actions.view.mockClear(); actions.play.mockClear();
    await act(async () => root.render(<ElementCard spec={{ type: "element", kind, title: kind, source: "noah", url: "/api/fichier", size: 100 }} />));
    await act(async () => (host.querySelector('[role="button"]') as HTMLElement).click());
    if (kind === "audio" || kind === "video") expect(actions.play).toHaveBeenCalledTimes(1);
    else expect(actions.view).toHaveBeenCalledWith(expect.objectContaining({ kind: "element", element: expect.objectContaining({ kind }) }));
    expect(host.textContent).toContain("Créé par Noah");
  }
  await act(async () => root.unmount());
});
