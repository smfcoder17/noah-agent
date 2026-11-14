// Une vidéo d'une plateforme externe dans le fil. Avant le clic sur Lecture, aucune requête ne part vers la plateforme :
// ni cadre, ni vignette. Elle ne saurait donc rien de ce qu'on lit dans Noah tant qu'on n'a pas choisi de regarder.
import { ExternalLink, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { videoFromUrl, type VideoRef } from "@/lib/chatMedia";
import { cn } from "@/lib/utils";
import { Button } from "./ui";
import { t } from "@/i18n";

// Les titres par défaut de chatMedia.ts (module pur, sans i18n), traduits ici.
const LABELS: Record<string, string> = {
  "Vidéo YouTube": t("Vidéo YouTube"), // i18n-ignore : clé, le titre écrit par chatMedia.ts
  "Vidéo Vimeo": t("Vidéo Vimeo"), // i18n-ignore : clé
  "Publication X": t("Publication X"), // i18n-ignore : clé
  "Vidéo TikTok": t("Vidéo TikTok"), // i18n-ignore : clé
  "Publication Instagram": t("Publication Instagram"), // i18n-ignore : clé
  "Vidéo Instagram": t("Vidéo Instagram"), // i18n-ignore : clé
};

// Une seule vidéo jouée à la fois : retirer le cadre de la précédente la coupe.
let playing: string | null = null;
const listeners = new Set<() => void>();
const play = (key: string | null) => {
  playing = key;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const nowPlaying = () => playing;

// Le lecteur d'une plateforme a besoin de ses scripts, de ses cookies chez elle et de son lien « Regarder sur… », rien de plus.
// Pas de allow-top-navigation : il ne peut pas remplacer Noah. Pas de allow-forms.
const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
const ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";
// YouTube refuse de jouer sans l'origine de la page (erreur 153) : il la reçoit, jamais le chemin. Les autres ne reçoivent rien.
const referrerOf = (video: VideoRef) => (video.platform === "youtube" ? "strict-origin-when-cross-origin" : "no-referrer");

const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Thème du lecteur X, seul à l'accepter. Une constante ajoutée à une adresse déjà validée. */
const frameUrl = (video: VideoRef) => (video.platform === "x" && isDark() ? `${video.embedUrl}&theme=dark` : video.embedUrl!);

export function VideoEmbed({ url, title }: { url: unknown; title?: unknown }) {
  const video = useMemo(() => videoFromUrl(url), [url]);
  const current = useSyncExternalStore(subscribe, nowPlaying);
  const on = !!video && current === video.key && !!video.embedUrl;
  const frame = useRef<HTMLIFrameElement>(null);
  // Le lecteur X annonce la hauteur de la publication : sans ça, un texte court laisse un grand vide sous lui.
  const [fitted, setFitted] = useState<number | null>(null);
  const measured = on && video.platform === "x";
  useEffect(() => {
    if (!measured) return setFitted(null);
    const listen = (e: MessageEvent) => {
      if (e.origin !== "https://platform.twitter.com" || e.source !== frame.current?.contentWindow) return;
      const height = e.data?.["twttr.embed"]?.params?.[0]?.height;
      if (typeof height === "number" && height >= 100 && height <= 1500) setFitted(Math.ceil(height));
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [measured]);
  if (!video) {
    // L'agent a écrit autre chose qu'une adresse reconnue : ni cadre, ni lien cliquable vers on ne sait quoi.
    return <p className="my-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">{t("Vidéo non reconnue : elle ne peut pas être lue ici.")}</p>;
  }
  const heading = (typeof title === "string" && title.trim().slice(0, 200)) || LABELS[video.label] || video.label;
  return (
    <section data-noah-video={video.platform} className="my-3 overflow-hidden rounded-2xl border border-border bg-surface">
      {on ? (
        <div className={cn("flex justify-center bg-black", video.platform === "x" && "bg-surface")}>
          <iframe
            ref={frame}
            style={fitted ? { height: fitted } : undefined}
            src={frameUrl(video)}
            title={heading}
            sandbox={SANDBOX}
            allow={ALLOW}
            allowFullScreen
            referrerPolicy={referrerOf(video)}
            className={cn("block border-0", video.portrait ? cn("h-[min(80dvh,720px)] w-full", video.platform === "x" ? "max-w-[550px]" : "max-w-[400px]") : "aspect-video w-full")}
          />
        </div>
      ) : video.embedUrl ? (
        <button
          type="button"
          onClick={() => play(video.key)}
          aria-label={t("Lire ici : {titre}", { titre: heading })}
          className={cn(
            "group flex w-full cursor-pointer flex-col items-center justify-center gap-2 bg-gradient-to-br from-muted via-surface to-muted px-4 text-center",
            video.portrait ? "h-48" : "aspect-video",
          )}
        >
          <span className="grid size-14 place-items-center rounded-full bg-foreground text-background shadow-sm transition-transform group-hover:scale-105">
            <Play className="size-6 translate-x-px" />
          </span>
          <span className="text-sm font-medium">{t("Lire ici")}</span>
          <span className="text-xs text-muted-foreground">{t("Rien ne part vers {plateforme} avant ce clic.", { plateforme: video.name })}</span>
        </button>
      ) : null}
      <footer className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-2", (on || video.embedUrl) && "border-t border-border/60")}>
        <div className="min-w-0 flex-1 basis-32">
          <p className="truncate text-sm font-semibold">{heading}</p>
          <p className="truncate text-xs text-muted-foreground">{video.name}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {on && (
            <Button size="sm" variant="ghost" onClick={() => play(null)}><X />{t("Fermer")}</Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <a href={video.openUrl} target="_blank" rel="noopener noreferrer" className="no-underline"><ExternalLink />{t("Ouvrir dans {plateforme}", { plateforme: video.name })}</a>
          </Button>
        </div>
      </footer>
    </section>
  );
}
