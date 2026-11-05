// « Autoriser cet appareil » : l'app de bureau (ou une autre app) a ouvert Noah dans le navigateur avec #autoriser=<id>.
// L'utilisateur, déjà connecté ici, voit quel appareil demande l'accès et décide. Le mot de passe ne passe jamais par l'app.
import { Laptop, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";
import { minutes } from "./PairingTime";

const KEY = "noah:autoriser";

/** À l'ouverture de la page : met de côté la demande (elle survit à l'écran de connexion) et nettoie l'adresse. */
export function keepApprovalRequest() {
  const m = location.hash.match(/autoriser=([\w-]+)/);
  if (!m) return;
  try {
    sessionStorage.setItem(KEY, m[1]);
  } catch {
    /* stockage bloqué : la demande reste dans l'adresse */
    return;
  }
  history.replaceState(null, "", location.pathname + location.search);
}

type Request = { appareil: string; type: string; ip: string; autre_reseau: boolean; verification: string | null; age: number; expire: number };

export function DeviceApproval() {
  const [id] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) ?? location.hash.match(/autoriser=([\w-]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  });
  const [req, setReq] = useState<Request | null>(null);
  const [state, setState] = useState<"ask" | "busy" | "ok" | "no">("ask");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!id) return;
    get<Request>(`/api/pairing/flow/${id}`).then(setReq).catch((e) => setError((e as Error).message));
  }, [id]);
  const close = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* rien à nettoyer */
    }
    setReq(null);
    setError("");
    setState("no");
  };
  const decide = async (decision: "autoriser" | "refuser") => {
    setState("busy");
    try {
      await send(`/api/pairing/flow/${id}/${decision}`, { verification: code });
      sessionStorage.removeItem(KEY);
      setState(decision === "autoriser" ? "ok" : "no");
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 403) setReq(null); // mauvais nombre : la demande est annulée
      setState("ask");
    }
  };

  if (!id || state === "no" || (!req && !error)) return null;
  const Icon = req?.type === "android" || req?.type === "ios" ? Smartphone : Laptop;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="approval-title" className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-lg">
        {state === "ok" ? (
          <>
            <h2 id="approval-title" className="text-lg font-semibold">Appareil autorisé</h2>
            {req?.verification ? (
              <p className="text-sm">
                Saisis maintenant ce nombre dans l'app : <b className="font-mono text-2xl tracking-widest">{req.verification}</b>
                <span className="mt-1 block text-xs text-muted-foreground">Ne le donne à personne, même si on te le demande au nom de Noah.</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Tu peux revenir dans l'app : elle s'ouvre toute seule. Cet onglet peut être fermé.</p>
            )}
            <Button className="self-end" onClick={close}>Fermer</Button>
          </>
        ) : req ? (
          <>
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-muted"><Icon className="size-5" /></span>
              <h2 id="approval-title" className="text-lg font-semibold">Autoriser cet appareil ?</h2>
            </div>
            <p className="text-sm">
              <b>{req.appareil}</b> demande à se connecter à ton compte Noah{req.ip ? <> depuis l'adresse <span className="font-mono">{req.ip}</span></> : null}.
            </p>
            <p className="text-xs text-muted-foreground">Demande faite {minutes(req.age)}, valable encore {minutes(req.expire, true)}. Ce nom, c'est l'appareil qui le donne : il ne prouve rien.</p>
            {req.autre_reseau && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Cette demande ne vient pas du même réseau que toi. Si tu n'as pas l'appareil en main, refuse.
              </p>
            )}
            {req.verification ? (
              <p className="text-sm">
                Après avoir autorisé, saisis ce nombre dans l'app : <b className="font-mono text-2xl tracking-widest">{req.verification}</b>
                <span className="mt-1 block text-xs text-muted-foreground">Ne le donne à personne, même si on te le demande au nom de Noah.</span>
              </p>
            ) : (
            <label className="flex flex-col gap-1 text-sm">
              Nombre affiché sur l'appareil
              <input
                inputMode="numeric" autoComplete="off" maxLength={3} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-center font-mono text-lg tracking-widest"
              />
            </label>
            )}
            <p className="text-xs text-muted-foreground">Autorise seulement si tu viens de lancer cette demande toi-même et que tu as l'appareil sous les yeux. Tu pourras le déconnecter dans Réglages → Appareils.</p>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => decide("refuser")} disabled={state === "busy"}>Refuser</Button>
              <Button onClick={() => decide("autoriser")} disabled={state === "busy" || (!req.verification && code.length !== 3)}>
                {state === "busy" && <Loader2 className="animate-spin" />}Autoriser cet appareil
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 id="approval-title" className="text-lg font-semibold">Demande expirée</h2>
            <ErrorText>{error}</ErrorText>
            <Button className="self-end" onClick={close}>Fermer</Button>
          </>
        )}
      </div>
    </div>
  );
}
