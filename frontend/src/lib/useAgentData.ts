import { subscribeUpdates } from "./events";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";
import { SEEN, SeenActive, seenGeneration } from "./seen";

/** Dernière réponse immédiate, puis relecture visible ; un refus efface aussi les données affichées. */
export function useAgentData<T>(path: string, { freshOnReload = true, refreshKey = 0 } = {}) {
  const active = useContext(SeenActive);
  const [data, setData] = useState<T | null>(() => (SEEN.get(path) as T) ?? null);
  const [error, setError] = useState("");
  const reading = useRef(false);
  const shownPath = useRef(path);
  shownPath.current = path;
  const read = useCallback((fresh: boolean) => {
    const generation = seenGeneration();
    const late = () => shownPath.current !== path || seenGeneration() !== generation;
    return get<T>(fresh ? `${path}?frais=1` : path)
      .then((d) => {
        if (late()) return;
        SEEN.set(path, d);
        setData(d);
        setError("");
      })
      .catch((e) => {
        if (late()) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          SEEN.delete(path);
          setData(null);
        }
        setError((e as Error).message);
      });
  }, [path]);
  /** Pour les gestes et le suivi : une lecture à la fois, avec les paramètres habituels de l'écran. */
  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      await read(freshOnReload);
    } finally {
      reading.current = false;
    }
  }, [read, freshOnReload]);
  useEffect(() => { setData((SEEN.get(path) as T) ?? null); }, [path]);
  useEffect(() => { if (active) void read(false); }, [read, active, refreshKey]);
  useEffect(() => active ? subscribeUpdates(load) : undefined, [active, load]);
  return { data, setData, error, setError, load };
}
