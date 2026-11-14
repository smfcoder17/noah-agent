import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ get: vi.fn(async () => ({ app_android: { version: "0.3.0", url: "https://github.com/smfcoder17/noah-agent/releases/download/v0.3.0/noah-agent-android.apk" } })) }));
import { AppUpdate } from "./AppUpdate";

afterEach(() => { delete window.Capacitor; localStorage.clear(); });

async function render(canal: string | undefined) {
  const installUpdate = vi.fn(async () => {});
  window.Capacitor = { Plugins: { NoahShell: { info: async () => ({ version: "0.2.0", ...(canal ? { canal } : {}) }), forget: async () => {}, installUpdate } } };
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AppUpdate />));
  await act(async () => {});
  return { host, root, installUpdate };
}

it("version Play : la mise à jour renvoie au Play Store, jamais à l'APK de GitHub", async () => {
  const { host, root, installUpdate } = await render("play");
  const button = host.querySelector("button")!;
  expect(button.textContent).toBe("Ouvrir le Play Store");
  expect(installUpdate).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("version GitHub, et app d'avant les canaux : « Installer » télécharge l'APK de la Release, comme avant", async () => {
  for (const canal of ["github", undefined]) {
    const { host, root, installUpdate } = await render(canal);
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Installer");
    await act(async () => button.click());
    expect(installUpdate).toHaveBeenCalledWith({ url: "https://github.com/smfcoder17/noah-agent/releases/download/v0.3.0/noah-agent-android.apk" });
    await act(async () => root.unmount());
  }
});
