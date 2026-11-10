import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { KeepAlive } from "./KeepAlive";

it("ne monte l'écran qu'à sa première visite et conserve son instance", async () => {
  const mounted = vi.fn(), unmounted = vi.fn();
  function Screen() { useEffect(() => { mounted(); return unmounted; }, []); return <input defaultValue="Données gardées" />; }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<KeepAlive active={false}><Screen /></KeepAlive>));
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => root.render(<KeepAlive active><Screen /></KeepAlive>));
  const field = host.querySelector("input");
  await act(async () => root.render(<KeepAlive active={false}><Screen /></KeepAlive>));
  expect(host.firstElementChild?.hasAttribute("hidden")).toBe(true);
  await act(async () => root.render(<KeepAlive active><Screen /></KeepAlive>));
  expect(host.querySelector("input")).toBe(field);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
