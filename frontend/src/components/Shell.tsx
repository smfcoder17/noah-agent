import { useEffect, useState } from "react";
import { useKeyboardInset } from "@/lib/keyboard";

export function MobileShell({ children }: { children: React.ReactNode }) { return <div className="noah-shell mobile-shell">{children}</div>; }
export function DesktopShell({ children }: { children: React.ReactNode }) { return <div className="noah-shell desktop-shell">{children}</div>; }
export function Shell({ children }: { children: React.ReactNode }) {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width:767px)").matches);
  useKeyboardInset();
  useEffect(() => { const q = matchMedia("(max-width:767px)"); const change = () => setMobile(q.matches); q.addEventListener("change", change); return () => q.removeEventListener("change", change); }, []);
  // Le conteneur conserve son identité quand on redimensionne la fenêtre.
  return <div className={`noah-shell ${mobile ? "mobile-shell" : "desktop-shell"}`}>{children}</div>;
}
