import type React from "react";
// « Autoriser cet appareil » : l'app de bureau (ou une autre app) a ouvert Noah dans le navigateur avec #autoriser=<id>.
// L'utilisateur, déjà connecté ici, voit quel appareil demande l'accès et décide. Le mot de passe ne passe jamais par l'app.
import { Laptop, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { t, tr } from "@/i18n";
import { ApiError, get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";
import { GrantProof } from "./GrantProof";
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

type Request = {
  appareil: string; type: string; ip: string; autre_reseau: boolean; verification: string | null; age: number; expire: number;
  preuve_requise: boolean; code_requis: boolean;
};

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
  const [password, setPassword] = useState("");
  const [secondCode, setSecondCode] = useState("");

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
  // i18n-ignore : décision envoyée au serveur
  const decide = async (decision: "autoriser" | "refuser") => {
    setState("busy");
    try {
      await send(`/api/pairing/flow/${id}/${decision}`, { verification: code, motdepasse: password, code: secondCode });
      sessionStorage.removeItem(KEY);
      setState(decision === "autoriser" ? "ok" : "no");
      // Plus rien à faire ici quand l'app n'attend aucun nombre : l'onglet se ferme si le navigateur le permet.
      if (decision === "refuser" || !req?.verification) setTimeout(() => window.close(), 1500);
    } catch (e) {
      setSecondCode(""); // un code ne sert qu'une fois : le suivant, s'il faut recommencer
      if (e instanceof ApiError && e.status === 428) { // page restée ouverte plus de 15 minutes : le serveur veut la preuve
        setReq(await get<Request>(`/api/pairing/flow/${id}`).catch(() => req));
      }
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 403) setReq(null); // mauvais nombre : la demande est annulée
      setState("ask");
    }
  };
  const proven = !req?.preuve_requise || (password !== "" && (!req.code_requis || secondCode !== ""));
  // Le clavier reste dans la fenêtre : le chat derrière n'est pas atteignable.
  const box = useRef<HTMLDivElement>(null);
  const shown = !(!id || state === "no" || (!req && !error));
  useEffect(() => {
    if (shown) box.current?.focus();
  }, [shown]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab" || !box.current) return;
    const all = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]")];
    if (!all.length) return;
    const [first, last] = [all[0], all[all.length - 1]];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!id || state === "no" || (!req && !error)) return null;
  const Icon = req?.type === "android" || req?.type === "ios" ? Smartphone : Laptop;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div ref={box} tabIndex={-1} onKeyDown={keys} role="dialog" aria-modal="true" aria-labelledby="approval-title" className="outline-none flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-6 shadow-lg">
        {state === "ok" ? (
          <>
            <h2 id="approval-title" className="text-lg font-semibold">{t("Appareil autorisé")}</h2>
            {req?.verification ? (
              <p className="text-sm">
                {tr("Saisis maintenant ce nombre dans l'app : {nombre}", { nombre: <b className="font-mono text-2xl tracking-widest">{req.verification}</b> })}
                <span className="mt-1 block text-xs text-muted-foreground">{t("Ne le donne à personne, même si on te le demande au nom de Noah.")}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("Tu peux revenir dans l'app : elle s'ouvre toute seule. Cet onglet peut être fermé.")}</p>
            )}
            <Button className="self-end" onClick={close}>{t("Fermer")}</Button>
          </>
        ) : req ? (
          <>
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-muted"><Icon className="size-5" /></span>
              <h2 id="approval-title" className="text-lg font-semibold">{t("Autoriser cet appareil ?")}</h2>
            </div>
            <p className="text-sm">
              {req.ip
                ? tr("{appareil} demande à se connecter à ton compte Noah depuis l'adresse {ip}.", { appareil: <b>{req.appareil}</b>, ip: <span className="font-mono">{req.ip}</span> })
                : tr("{appareil} demande à se connecter à ton compte Noah.", { appareil: <b>{req.appareil}</b> })}
            </p>
            <p className="text-xs text-muted-foreground">{t("Demande faite {age}, valable encore {reste}. Ce nom, c'est l'appareil qui le donne : il ne prouve rien.", { age: minutes(req.age), reste: minutes(req.expire, true) })}</p>
            {req.autre_reseau && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                {t("Cette demande ne vient pas du même réseau que toi. Si tu n'as pas l'appareil en main, refuse.")}
              </p>
            )}
            {req.verification ? (
              <p className="text-sm">
                {tr("Après avoir autorisé, saisis ce nombre dans l'app : {nombre}", { nombre: <b className="font-mono text-2xl tracking-widest">{req.verification}</b> })}
                <span className="mt-1 block text-xs text-muted-foreground">{t("Ne le donne à personne, même si on te le demande au nom de Noah.")}</span>
              </p>
            ) : (
            <label className="flex flex-col gap-1 text-sm">
              {t("Nombre affiché sur l'appareil")}
              <input
                inputMode="numeric" autoComplete="off" maxLength={3} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-center font-mono text-lg tracking-widest"
              />
            </label>
            )}
            <p className="text-xs text-muted-foreground">{t("Autorise seulement si tu viens de lancer cette demande toi-même et que tu as l'appareil sous les yeux. Tu pourras le déconnecter dans Réglages → Appareils.")}</p>
            {req.preuve_requise && <GrantProof password={password} code={secondCode} needCode={req.code_requis} onPassword={setPassword} onCode={setSecondCode} />}
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => decide("refuser")} disabled={state === "busy"}>{t("Refuser")}</Button>
              <Button onClick={() => decide("autoriser")} disabled={state === "busy" || (!req.verification && code.length !== 3) || !proven}>
                {state === "busy" && <Loader2 className="animate-spin" />}{t("Autoriser cet appareil")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 id="approval-title" className="text-lg font-semibold">{t("Demande impossible")}</h2>
            <ErrorText>{error}</ErrorText>
            <Button className="self-end" onClick={close}>{t("Fermer")}</Button>
          </>
        )}
      </div>
    </div>
  );
}
