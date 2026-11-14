// Posts de réseau social, produits et sources : montrés tels quels dans le fil, sans clic pour les ouvrir.
import { ExternalLink, Star } from "lucide-react";
import { useContext } from "react";
import { mediaUrl } from "@/lib/api";
import { AgentContext } from "@/lib/agentContext";
import type { LinkItem, Normalized, PostItem, PostTone, ProductItem } from "@/lib/blocks";
import { cn, safeMedia } from "@/lib/utils";
import { SensitiveText } from "./SensitiveText";
import { useViewer } from "./Viewer";
import { t } from "@/i18n";

const TONES: Record<PostTone, string> = {
  ok: "bg-ok/12 text-ok",
  info: "bg-accent-soft text-accent",
  muted: "bg-muted text-muted-foreground",
  warn: "bg-warn-soft text-warn",
};

function useImage() {
  const { agentId } = useContext(AgentContext);
  return (image?: string) => (!image ? undefined : image.startsWith("/opt/data/") ? mediaUrl(agentId, image) : safeMedia(image));
}

function Header({ title, note }: { title?: string; note?: string }) {
  if (!title && !note) return null;
  return <header className="mb-2">{title && <h3 className="text-sm font-semibold"><SensitiveText text={title} /></h3>}{note && <p className="text-xs text-muted-foreground"><SensitiveText text={note} /></p>}</header>;
}

function Post({ post }: { post: PostItem }) {
  const src = useImage();
  const view = useViewer();
  const picture = src(post.image);
  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3" aria-label={post.state ? t("Post {plateforme} · {etat}", { plateforme: post.platform, etat: post.state.label }) : t("Post {plateforme}", { plateforme: post.platform })}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <b className="text-[13px] text-foreground">{post.platform}</b>
        {post.account && <span><SensitiveText text={post.account} /></span>}
        {post.date && <span>· {post.date}</span>}
        {post.state && <span className={cn("ml-auto rounded-full px-2 py-px text-[11px] font-semibold", TONES[post.state.tone])}>{post.state.label}</span>}
      </div>
      {post.text && <p className="text-[14px] leading-snug whitespace-pre-line"><SensitiveText text={post.text} /></p>}
      {picture && (
        <button type="button" className="relative block cursor-zoom-in overflow-hidden rounded-xl bg-muted" onClick={() => view({ kind: "image", src: picture, title: post.text?.slice(0, 60) || post.platform })}>
          <img src={picture} alt="" loading="lazy" className="max-h-80 w-full object-cover" />
          {post.more > 0 && <span className="absolute right-2 bottom-2 rounded-md bg-surface/90 px-1.5 py-px text-[11px] font-semibold">+{post.more}</span>}
        </button>
      )}
      {post.note && <p className="text-xs text-muted-foreground"><SensitiveText text={post.note} /></p>}
      {post.url && <a href={post.url} target="_blank" rel="noopener noreferrer" className="noah-block-link inline-flex items-center gap-1 self-start text-xs font-medium"><ExternalLink className="size-3.5" />{t("Voir le post")}</a>}
    </article>
  );
}

function Product({ item }: { item: ProductItem }) {
  const src = useImage();
  const picture = src(item.image);
  const body = (
    <>
      <div className="relative aspect-square overflow-hidden rounded-xl bg-muted">
        {picture && <img src={picture} alt="" loading="lazy" className="size-full object-contain" />}
        {item.badge && <span className="absolute top-1.5 left-1.5 rounded-md bg-surface px-1.5 py-px text-[11px] font-semibold shadow-sm">{item.badge}</span>}
      </div>
      <span className="line-clamp-2 text-[13px] leading-snug font-medium"><SensitiveText text={item.title} /></span>
      {item.price && <span className="text-[15px] font-semibold tabular-nums">{item.price}</span>}
      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {item.merchant && <span>{item.merchant}</span>}
        {item.rating && <span className="inline-flex items-center gap-0.5"><Star className="size-3" aria-hidden />{item.rating}</span>}
      </span>
      {item.note && <span className="text-xs text-muted-foreground"><SensitiveText text={item.note} /></span>}
    </>
  );
  const box = "flex w-44 shrink-0 snap-start flex-col gap-1 rounded-2xl border border-border bg-surface p-2.5 no-underline";
  return item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className={cn(box, "hover:border-accent")}>{body}</a> : <div className={box}>{body}</div>;
}

function Link({ item, index }: { item: LinkItem; index: number }) {
  return (
    <li>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex gap-3 rounded-xl px-2 py-1.5 no-underline hover:bg-muted">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{index + 1}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground"><SensitiveText text={item.title} /></span>
          <span className="truncate text-xs text-muted-foreground">{item.site}{item.note && <> · <SensitiveText text={item.note} /></>}</span>
        </span>
      </a>
    </li>
  );
}

export function BlockCards({ block }: { block: Normalized }) {
  return (
    <section className="noah-block my-3" data-noah-block={block.type}>
      <Header title={block.title} note={block.note} />
      {block.type === "posts" ? (
        <div className="flex flex-col gap-2">{block.items.map((p, i) => <Post key={i} post={p} />)}</div>
      ) : block.type === "products" ? (
        <div className="flex snap-x gap-2 overflow-x-auto pb-1">{block.items.map((p, i) => <Product key={i} item={p} />)}</div>
      ) : (
        <ol className="flex flex-col rounded-2xl border border-border bg-surface p-1.5">{block.items.map((l, i) => <Link key={i} item={l} index={i} />)}</ol>
      )}
    </section>
  );
}
