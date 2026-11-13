import { afterEach, describe, expect, it, vi } from "vitest";
import { watchScreenConnection } from "./screenCache";

// Une page noVNC : seul compte le marqueur `noVNC_connected` posé sur <html>.
const page = () => document.implementation.createHTMLDocument("noVNC");
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("watchScreenConnection : l'écran suit la connexion noVNC au fil de l'eau", () => {
  afterEach(() => vi.useRealTimers());

  it("montre l'écran dès que noVNC se connecte, sans attendre un relevé du serveur", async () => {
    const doc = page();
    const seen: boolean[] = [];
    const stop = watchScreenConnection(doc, (c) => seen.push(c));
    expect(seen).toEqual([false]); // première connexion : on attend
    doc.documentElement.classList.add("noVNC_connected");
    await flush();
    expect(seen).toEqual([false, true]);
    stop();
  });

  it("une coupure courte (reconnexion automatique) ne cache pas l'écran", async () => {
    vi.useFakeTimers();
    const doc = page();
    doc.documentElement.classList.add("noVNC_connected");
    const seen: boolean[] = [];
    const stop = watchScreenConnection(doc, (c) => seen.push(c), 3000);
    doc.documentElement.classList.remove("noVNC_connected");
    await flush();
    vi.advanceTimersByTime(1500);
    doc.documentElement.classList.add("noVNC_connected");
    await flush();
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([true]);
    stop();
  });

  it("une vraie coupure finit par le dire, puis la reconnexion rend l'écran", async () => {
    vi.useFakeTimers();
    const doc = page();
    doc.documentElement.classList.add("noVNC_connected");
    const seen: boolean[] = [];
    const stop = watchScreenConnection(doc, (c) => seen.push(c), 3000);
    doc.documentElement.classList.remove("noVNC_connected");
    await flush();
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([true, false]);
    doc.documentElement.classList.add("noVNC_connected");
    await flush();
    expect(seen).toEqual([true, false, true]);
    stop();
  });

  it("une fois arrêté, il ne signale plus rien", async () => {
    const doc = page();
    const seen: boolean[] = [];
    watchScreenConnection(doc, (c) => seen.push(c))();
    doc.documentElement.classList.add("noVNC_connected");
    await flush();
    expect(seen).toEqual([false]);
  });
});
