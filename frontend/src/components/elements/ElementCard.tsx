import { useContext, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { rawFileUrl } from "@/lib/api";
import { ELEMENTS, elementName, elementUrl, sourceName, type ElementSpec } from "@/lib/elements";
import { useViewer } from "../Viewer";
import { useMedia } from "./MediaPlayers";

export function ElementCard({ spec }: { spec: ElementSpec }) {
  const view = useViewer();
  const play = useMedia();
  const { agentId } = useContext(AgentContext);
  const [gone, setGone] = useState(false);
  const url = spec.path ? rawFileUrl(agentId, spec.path) : elementUrl(spec.url);
  const item = { ...spec, url };
  const open = () => { if ((spec.kind === "video" || spec.kind === "audio") && url) play({ spec: item, url }); else view({ kind: "element", element: item }); };
  return <button className="element-card" aria-label={elementName(spec)} onClick={open} onDoubleClick={() => view({ kind: "element", element: item, fullscreen: true })}>
    {spec.kind === "image" && url && !gone ? <img src={url} alt={spec.description || spec.title} loading="lazy" onError={() => setGone(true)} /> : <span className="element-kind">{ELEMENTS[spec.kind]}</span>}
    <span className="element-meta"><b>{spec.title}</b><small>{sourceName(spec)} · {spec.size != null ? `${(spec.size / 1024).toLocaleString("fr", { maximumFractionDigits: 1 })} Ko` : "Taille non renseignée"}{spec.version && ` · v${spec.version}`}</small>{gone && <small>Fichier introuvable</small>}</span><span aria-hidden>›</span>
  </button>;
}
