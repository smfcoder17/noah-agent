import { useContext, useState } from "react";
import { SeenActive } from "@/lib/seen";

/** Une visite monte l'écran ; les suivantes retrouvent la même instance. */
export function KeepAlive({ active, children, className }: { active: boolean; children: React.ReactNode; className?: string }) {
  const parent = useContext(SeenActive);
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return <div hidden={!active} className={className}><SeenActive.Provider value={parent && active}>{(visited || active) && children}</SeenActive.Provider></div>;
}
