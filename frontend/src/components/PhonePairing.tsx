// Réglages > Téléphone : un QR code à usage unique (10 min) que le téléphone scanne pour se connecter.
import qrcode from "qrcode-generator";
import { Loader2, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { send } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { Button, ErrorText } from "./ui";

type Pairing = { adresse: string; expire: number; local: boolean };

function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [text]);
  // Fond blanc même en thème sombre : les appareils photo lisent mal un QR code inversé.
  return <div className="size-56 rounded-xl bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PhonePairing() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // App de bureau : l'adresse de l'ordinateur sur le Wi-Fi remplace « localhost » dans le QR code.
  const app = desktop();
  const [lan, setLan] = useState<{ open: boolean; url: string | null } | null>(null);
  useEffect(() => {
    app?.lanStatus().then(setLan).catch(() => {});
  }, [app]);
  const openLan = async () => {
    setBusy(true);
    try {
      setLan(await app!.openLan());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const viaLan = !!(pairing?.local && lan?.open && lan.url);
  const target = pairing && viaLan ? pairing.adresse.replace(/^https?:\/\/[^/]+/, lan!.url!) : pairing?.adresse ?? "";

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await send<Pairing>("/api/pairing", {});
      setPairing(p);
      setLeft(p.expire);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Scanne ce code avec l'appareil photo de ton téléphone : Noah s'ouvre déjà connecté. Ajoute-le ensuite à l'écran
        d'accueil (menu du navigateur, « Ajouter à l'écran d'accueil ») pour l'utiliser comme une application.
      </p>
      {pairing && left > 0 ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <QR text={target} />
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p>
              Valable encore <b>{Math.floor(left / 60)} min {String(left % 60).padStart(2, "0")} s</b>, pour un seul téléphone.
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">{target}</p>
            {viaLan && <p className="text-xs text-muted-foreground">Ton téléphone doit être sur le même Wi-Fi que cet ordinateur.</p>}
            {pairing.local && app && !lan?.open && (
              <Button size="sm" className="self-start" onClick={openLan} disabled={busy || !lan?.url}>
                Ouvrir Noah à mon Wi-Fi
              </Button>
            )}
            {pairing.local && !viaLan && !app && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Cette adresse ne marche que sur cet ordinateur. Pour ton téléphone, ouvre Noah depuis l'adresse de
                l'ordinateur sur ton réseau (avec <code>APOLLO_BIND=0.0.0.0</code> dans <code>.env</code>), ou installe
                Noah sur un VPS avec un domaine, puis affiche le code depuis cette adresse-là.
              </p>
            )}
            <Button variant="outline" size="sm" className="self-start" onClick={create} disabled={busy}>Nouveau code</Button>
          </div>
        </div>
      ) : (
        <Button className="self-start" onClick={create} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {pairing ? "Le code a expiré : en afficher un autre" : "Afficher le QR code"}
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
