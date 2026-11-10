import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ inAndroidApp: () => false }));
import { useKeyboardInset } from "./keyboard";
it("garde la même règle de clavier pour discussion, réglages, compétence et connexion", async () => {
  class Viewport extends EventTarget { height = 844; offsetTop = 0; scale = 1; }
  const viewport = new Viewport();
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 844); vi.stubGlobal("requestAnimationFrame", (f: () => void) => { f(); return 0; });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  function Screen({ label }: { label: string }) { const open = useKeyboardInset(); return <section data-open={open}><input aria-label={label} /></section>; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  for (const label of ["Discussion", "Réglages", "Compétence", "Connexion"]) {
    await act(async () => root.render(<Screen key={label} label={label} />));
    host.querySelector("input")!.focus();
    await act(async () => { viewport.height = 544; viewport.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.dataset.keyboard).toBe("open");
    expect(document.documentElement.style.getPropertyValue("--kb")).toBe("300px");
    await act(async () => { viewport.height = 844; viewport.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.dataset.keyboard).toBe("closed");
  }
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
