// Logo du fournisseur d'un modèle (bibliothèque d'icônes LobeHub, MIT), à partir du préfixe de son identifiant.
import { useState } from "react";
import { cn } from "@/lib/utils";

const FILES = import.meta.glob(
  "/node_modules/@lobehub/icons-static-svg/icons/{anthropic,claude-color,openai,google-color,gemini-color,grok,deepseek-color,kimi-color,zai,qwen-color,alibaba-color,meta-color,mistral-color,minimax-color,nvidia-color,flux,bytedance-color,recraft,krea,hunyuan-color,microsoft-color,elevenlabs,fishaudio,assemblyai-color,kling-color,runway,liquid,cohere-color,perplexity-color,nova-color,ai21,nousresearch,ibm,inception,arcee-color,stepfun-color,wenxin-color,yi-color,openrouter-color,ollama,upstage-color,chatglm-color,ideogram,stability-color,luma-color,hailuo-color,muse-color,vidu-color}.svg",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

const icon = (name: string) => FILES[`/node_modules/@lobehub/icons-static-svg/icons/${name}.svg`];

// Préfixe OpenRouter (labo) → icône.
const LABS: Record<string, string> = {
  anthropic: "anthropic", openai: "openai", google: "google-color", "x-ai": "grok", deepseek: "deepseek-color",
  moonshotai: "kimi-color", "z-ai": "zai", qwen: "qwen-color", alibaba: "alibaba-color", meta: "meta-color",
  "meta-llama": "meta-color", mistralai: "mistral-color", minimax: "minimax-color", nvidia: "nvidia-color",
  "black-forest-labs": "flux", bytedance: "bytedance-color", "bytedance-seed": "bytedance-color", recraft: "recraft",
  krea: "krea", tencent: "hunyuan-color", microsoft: "microsoft-color", elevenlabs: "elevenlabs", "fish-audio": "fishaudio",
  assemblyai: "assemblyai-color", kwaivgi: "kling-color", runway: "runway", liquid: "liquid", cohere: "cohere-color",
  perplexity: "perplexity-color", amazon: "nova-color", ai21: "ai21", nousresearch: "nousresearch", "ibm-granite": "ibm",
  inception: "inception", "arcee-ai": "arcee-color", "stepfun-ai": "stepfun-color", baidu: "wenxin-color", "01-ai": "yi-color",
  gemini: "gemini-color", mistral: "mistral-color", "ollama-cloud": "ollama", openrouter: "openrouter-color", ollama: "ollama", upstage: "upstage-color", thudm: "chatglm-color", ideogram: "ideogram",
  "stability-ai": "stability-color", luma: "luma-color",
};

// Noms affichés des labos (filtres). Noms de marques : les mêmes dans toutes les langues.
export const LAB_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", "x-ai": "xAI", deepseek: "DeepSeek", moonshotai: "Moonshot", // i18n-ignore : marque
  "z-ai": "Z.ai", qwen: "Qwen", alibaba: "Alibaba", meta: "Meta", "meta-llama": "Meta", mistralai: "Mistral", // i18n-ignore : marque
  minimax: "MiniMax", nvidia: "NVIDIA", "black-forest-labs": "Black Forest Labs", bytedance: "ByteDance", // i18n-ignore : marque
  "bytedance-seed": "ByteDance", recraft: "Recraft", krea: "Krea", tencent: "Tencent", microsoft: "Microsoft", // i18n-ignore : marque
  elevenlabs: "ElevenLabs", "fish-audio": "Fish Audio", assemblyai: "AssemblyAI", kwaivgi: "Kling", runway: "Runway", // i18n-ignore : marque
  heygen: "HeyGen", deepgram: "Deepgram", sourceful: "Sourceful", // i18n-ignore : marque
};

export const labOf = (modelId: string) => modelId.split("/")[0].toLowerCase();
export const labName = (lab: string) => LAB_NAMES[lab] ?? lab.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

const LOCAL = import.meta.glob("../assets/providers/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;
export const providerLogo = (id: string) => id === "mammouth" ? LOCAL["../assets/providers/mammouth.svg"] : (LABS[id] ? icon(LABS[id]) : undefined);

/** Logo du labo ; à défaut, son initiale dans une pastille. */
export function ProviderLogo({ modelId, lab, className }: { modelId?: string; lab?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const key = lab ?? labOf(modelId ?? "");
  // Les modèles Kling d'OpenRouter s'appellent kwaivgi/…, ceux d'Hailuo minimax/hailuo-…
  const name = modelId?.includes("hailuo") ? "hailuo-color" : modelId?.includes("/muse") ? "muse-color" : LABS[key];
  const src = key === "mammouth" ? providerLogo(key) : name ? icon(name) : undefined;
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center overflow-hidden rounded-md bg-white ring-1 ring-border", key === "mammouth" && "bg-[#ff7a2f]", className)} title={labName(key)}>
      {src && !failed ? (
        <img src={src} onError={() => setFailed(true)} alt="" className="size-[70%]" />
      ) : (
        <span className="text-[11px] font-bold uppercase text-muted-foreground">{key.slice(0, 1)}</span>
      )}
    </span>
  );
}
