import { describe, expect, it, vi } from "vitest";
import { accordLabel, subscribeUpdates, type AccordClosed } from "./events";
vi.mock("./api", () => ({ currentAuthEpoch: () => "test", get: async () => [], request: vi.fn((_p, init) => new Promise((_ok, reject) => init.signal.addEventListener("abort", () => reject(new Error("fermé"))))) }));
import { request } from "./api";

describe("accords synchronisés", () => {
  it("nomme l'appareil qui a répondu et ne présente pas une expiration comme un accord", () => {
    const closed = { etat: "donne", par: "ordinateur" } as AccordClosed;
    expect(accordLabel(closed)).toBe("Accord donné sur l'ordinateur");
    expect(accordLabel({ ...closed, etat: "expire" })).toBeNull();
    expect(accordLabel({ ...closed, etat: "refuse", par: "téléphone" })).toBe("Accord refusé sur le téléphone");
  });
  it("partage le transport entre plusieurs écrans et le ferme au dernier départ", () => {
    const a = subscribeUpdates(() => {});
    const b = subscribeUpdates(() => {});
    expect(request).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(request).mock.calls[0][1]!.signal!;
    a();
    expect(signal.aborted).toBe(false);
    b();
    expect(signal.aborted).toBe(true);
  });
});
