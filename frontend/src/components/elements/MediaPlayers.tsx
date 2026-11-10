import { createContext, useContext, useRef, useState } from "react";
import type { ElementSpec } from "@/lib/elements";

type Playing = { spec: ElementSpec; url: string };
const Media = createContext<(item: Playing) => void>(() => {});
export const useMedia = () => useContext(Media);
export function MediaPlayers({ children }: { children: React.ReactNode }) {
  const [playing, setPlaying] = useState<Playing | null>(null);
  return <Media.Provider value={setPlaying}>{children}{playing && (playing.spec.kind === "audio" ? <AudioBar item={playing} close={() => setPlaying(null)} /> : <VideoMini item={playing} close={() => setPlaying(null)} />)}</Media.Provider>;
}
export function AudioBar({ item, close }: { item: Playing; close: () => void }) {
  return <section className="audio-bar" aria-label={`Lecture de ${item.spec.title}`}><span>{item.spec.title}</span><audio autoPlay controls src={item.url} /><button onClick={close} aria-label="Fermer l'audio">✕</button></section>;
}
export function VideoMini({ item, close }: { item: Playing; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [position, setPosition] = useState({ x: 16, y: 130 });
  const start = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  return <div ref={box} className="video-mini" style={{ left: position.x, top: position.y }}>
    <button className="video-grip" aria-label="Déplacer la vidéo" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y }; }}
      onPointerMove={(e) => { const s = start.current; if (s) setPosition({ x: Math.max(0, Math.min(innerWidth - (box.current?.offsetWidth ?? 200), s.px + e.clientX - s.x)), y: Math.max(0, Math.min(innerHeight - 140, s.py + e.clientY - s.y)) }); }}
      onPointerUp={() => { start.current = null; setPosition((p) => ({ ...p, x: p.x < 40 ? 8 : p.x + (box.current?.offsetWidth ?? 200) > innerWidth - 40 ? innerWidth - (box.current?.offsetWidth ?? 200) - 8 : p.x })); }}>⠿</button>
    <video ref={video} autoPlay controls playsInline src={item.url} />
    <button onClick={() => void video.current?.requestFullscreen()} aria-label="Agrandir la vidéo">⛶</button>
    <label>Vitesse <select defaultValue="1" onChange={(e) => { if (video.current) video.current.playbackRate = Number(e.target.value); }}>{[0.5, 1, 1.5, 2].map((r) => <option key={r}>{r}</option>)}</select></label>
    <button onClick={close} aria-label="Fermer la vidéo">✕</button>
  </div>;
}
