import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ElementSpec } from "@/lib/elements";
import { SensitiveText } from "../SensitiveText";
import { t } from "@/i18n";

type Playing = { spec: ElementSpec; url: string };
const Media = createContext<(item: Playing) => void>(() => {});
export const useMedia = () => useContext(Media);
export function MediaPlayers({ children }: { children: React.ReactNode }) {
  const [playing, setPlaying] = useState<Playing | null>(null);
  useEffect(() => { const close = () => setPlaying(null); window.addEventListener("noah:media-close", close); return () => window.removeEventListener("noah:media-close", close); }, []);
  return <Media.Provider value={setPlaying}>{children}{playing && (playing.spec.kind === "audio" ? <AudioBar key={playing.url} item={playing} close={() => setPlaying(null)} /> : <VideoMini key={playing.url} item={playing} close={() => setPlaying(null)} />)}</Media.Provider>;
}
export function AudioBar({ item, close }: { item: Playing; close: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]), [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!window.AudioContext) return;
    let live = true;
    const controller = new AbortController(), ctx = new AudioContext();
    void fetch(item.url, { credentials: "same-origin", signal: controller.signal }).then(async (r) => {
      if (!r.ok || Number(r.headers.get("content-length") || 0) > 6_000_000) return;
      const data = await r.arrayBuffer(); if (data.byteLength > 6_000_000 || !live) return;
      const decoded = await ctx.decodeAudioData(data); if (!live) return;
      const channel = decoded.getChannelData(0), step = Math.max(1, Math.floor(channel.length / 64));
      setPeaks(Array.from({ length: 64 }, (_, i) => { let peak = 0; for (let j = i * step; j < Math.min(channel.length, (i + 1) * step); j++) peak = Math.max(peak, Math.abs(channel[j])); return peak; }));
    }).catch(() => {});
    return () => { live = false; controller.abort(); void ctx.close(); };
  }, [item.url]);
  return <section className="audio-bar" aria-label={t("Lecture audio")}><span><SensitiveText text={item.spec.title} />{peaks.length > 0 && <svg viewBox="0 0 256 30" width="128" height="26" role="img" aria-label={t("Forme d'onde de l'audio")}>{peaks.map((p, i) => <rect key={i} x={i * 4} y={15 - p * 14} width="3" height={Math.max(1, p * 28)} rx="1" fill={i / 64 < progress ? "var(--accent)" : "var(--line)"} />)}</svg>}</span><audio ref={audio} autoPlay controls src={item.url} onTimeUpdate={() => { const a = audio.current; if (a?.duration) setProgress(a.currentTime / a.duration); }} /><button onClick={close} aria-label={t("Fermer l'audio")}>✕</button></section>;
}
export function VideoMini({ item, close }: { item: Playing; close: () => void }) {
  const video = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null);
  const [expanded, expand] = useState(true), [position, setPosition] = useState({ x: 16, y: 130 }), [width, setWidth] = useState(220);
  const drag = useRef<{ x: number; y: number; px: number; py: number; w: number; resize: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>()), pinch = useRef<{ distance: number; width: number } | null>(null);
  const stop = () => {
    drag.current = null; pointers.current.clear(); pinch.current = null;
    const height = box.current?.offsetHeight || 160;
    setPosition((p) => p.x < 40 || p.y < 40 || p.x + width > innerWidth - 40 || p.y + height > innerHeight - 40 ? { x: p.x < (innerWidth - width) / 2 ? 8 : Math.max(8, innerWidth - width - 8), y: p.y < (innerHeight - height) / 2 ? 8 : Math.max(8, innerHeight - height - 8) } : p);
  };
  return <div ref={box} className={`video-mini ${expanded ? "video-expanded" : ""}`} style={expanded ? undefined : { left: position.x, top: position.y, width }}
    onPointerDown={(e) => { pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pointers.current.size === 2) { const [a,b] = [...pointers.current.values()]; pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), width }; } }}
    onPointerMove={(e) => { if (expanded || !pointers.current.has(e.pointerId)) return; pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); const pair = [...pointers.current.values()]; if (pair.length === 2 && pinch.current?.distance) setWidth(Math.max(168, Math.min(innerWidth - 16, pinch.current.width * Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) / pinch.current.distance))); }} onPointerUp={() => { pointers.current.clear(); pinch.current = null; }}>
    {!expanded && <button className="video-grip" aria-label={t("Déplacer la vidéo")} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y, w: width, resize: false }; }} onPointerMove={(e) => { const s = drag.current; if (s && !s.resize) setPosition({ x: Math.max(0, Math.min(innerWidth - width, s.px + e.clientX - s.x)), y: Math.max(0, Math.min(innerHeight - (box.current?.offsetHeight || 160), s.py + e.clientY - s.y)) }); }} onPointerUp={stop} onPointerCancel={stop}>⠿</button>}
    <video ref={video} autoPlay controls playsInline src={item.url}>{typeof item.spec.data?.subtitles === "string" && /^\/api\//.test(item.spec.data.subtitles) && <track kind="subtitles" src={item.spec.data.subtitles} srcLang="fr" label={t("Français")} default />}</video>
    <div className="flex gap-2 items-center"><button onClick={() => expand(!expanded)} aria-label={expanded ? t("Continuer à discuter") : t("Agrandir la vidéo")}>{expanded ? t("Continuer à discuter") : t("Agrandir")}</button><button onClick={() => void video.current?.requestFullscreen()} aria-label={t("Plein écran vidéo")}>⛶</button><label>{t("Vitesse")} <select defaultValue="1" onChange={(e) => { if (video.current) video.current.playbackRate = Number(e.target.value); }}>{[0.5, 1, 1.5, 2].map((r) => <option key={r}>{r}</option>)}</select></label><button onClick={close} aria-label={t("Fermer la vidéo")}>✕</button></div>
    {!expanded && <button className="video-resize" aria-label={t("Redimensionner la vidéo")} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y, w: width, resize: true }; }} onPointerMove={(e) => { const s = drag.current; if (s?.resize) setWidth(Math.max(168, Math.min(innerWidth - position.x - 8, s.w + e.clientX - s.x))); }} onPointerUp={stop} onPointerCancel={stop}>◢</button>}
  </div>;
}
