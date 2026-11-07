// Page de démonstration du visage, hors production : `npm run dev` puis /demo-visage.html. Le build ne l'embarque pas (une seule
// entrée, index.html). Paramètres : ?face=gomme&detail=antenne&state=idle&size=240&seed=x&count=30&color=%23ff7a59&tile=0 pour un seul cas.
import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime, useLocalRuntime } from "@assistant-ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CallStage } from "@/components/CallStage";
import { NOAH_COLORS, NOAH_DETAILS, NOAH_SHAPES, Noah, NoahTile, type NoahHandle, type NoahReaction, type NoahState } from "@/components/Noah";
import { Thread } from "@/components/Thread";
import { AgentContext } from "@/lib/agentContext";
import { noahActive, noahFaces, noahPaused, noahStats, setNoahPaused } from "@/lib/noahFace";
import "./index.css";

const STATES: { id: NoahState; name: string }[] = [
  { id: "idle", name: "Repos" },
  { id: "listening", name: "Écoute" },
  { id: "thinking", name: "Réflexion" },
  { id: "speaking", name: "Parole" },
  { id: "working", name: "Travail" },
  { id: "waiting", name: "Attente" },
  { id: "pleased", name: "Fini" },
  { id: "upset", name: "Erreur" },
];
const REACTIONS: NoahReaction[] = ["hop", "joy", "greet", "surprise", "attention", "aha", "nod", "shake", "lookLeft", "lookRight", "wiggle", "sad", "confused", "sigh", "puff"];

const params = new URLSearchParams(location.search);
const solo = params.get("face");

declare global {
  interface Window {
    noahDemo: Record<string, unknown>;
  }
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      {children}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Solo() {
  const size = Number(params.get("size") ?? 240);
  const count = Number(params.get("count") ?? 1);
  const tile = params.get("tile") !== "0";
  const [state, setState] = useState<NoahState>((params.get("state") as NoahState) ?? "idle");
  const handles = useRef<(NoahHandle | null)[]>([]);
  const color = params.get("color") ?? NOAH_COLORS[0].hex;
  const mic = useRef({ current: 0 }).current;
  const voice = useRef({ current: 0 }).current;
  useEffect(() => {
    window.noahDemo = {
      setState,
      react: (kind: NoahReaction) => handles.current.forEach((h) => h?.react(kind)),
      faces: noahFaces,
      active: noahActive,
      stats: noahStats,
      setPaused: setNoahPaused,
      isPaused: noahPaused,
      mic,
      voice,
    };
  }, [mic, voice]);
  const face = (i: number) => {
    const common = {
      color,
      shape: solo ?? undefined,
      detail: params.get("detail") ?? undefined,
      state,
      seed: count > 1 ? `${params.get("seed") ?? "demo"}-${i}` : params.get("seed") ?? "demo",
      micLevel: params.has("levels") ? mic : undefined,
      voiceLevel: params.has("voice") ? voice : undefined,
      handle: (h: NoahHandle | null) => {
        handles.current[i] = h;
      },
    };
    return tile ? (
      <NoahTile key={i} {...common} className="" />
    ) : (
      <Noah key={i} {...common} />
    );
  };
  return (
    <div
      id="stage"
      className={count > 1 ? "grid gap-4 p-6" : "grid place-items-center p-16"}
      style={count > 1 ? { gridTemplateColumns: `repeat(auto-fill, ${size}px)`, background: "#fff" } : { background: "#fff" }}
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ width: size, height: size, display: "grid" }} data-face-box={i}>
          {face(i)}
        </span>
      ))}
    </div>
  );
}

function Gallery() {
  const handles = useRef<Map<string, NoahHandle | null>>(new Map());
  const [state, setState] = useState<NoahState | null>(null);
  const [still, setStill] = useState(noahPaused());
  const [detail, setDetail] = useState("");
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Le visage de Noah</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">État commun :</span>
          <button type="button" className="rounded-lg border border-border px-2 py-1" onClick={() => setState(null)}>Par colonne</button>
          {STATES.map((s) => (
            <button key={s.id} type="button" className="rounded-lg border border-border px-2 py-1" onClick={() => setState(s.id)}>{s.name}</button>
          ))}
          <span className="ml-3 text-muted-foreground">Détail :</span>
          {NOAH_DETAILS.map((d) => (
            <button key={d.id} type="button" className="rounded-lg border border-border px-2 py-1" onClick={() => setDetail(d.id)}>{d.name}</button>
          ))}
          <label className="ml-3 flex items-center gap-1">
            <input
              type="checkbox"
              checked={still}
              onChange={(e) => {
                setStill(e.target.checked);
                setNoahPaused(e.target.checked);
              }}
            />
            Immobiles
          </label>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {REACTIONS.map((r) => (
            <button key={r} type="button" className="rounded-lg border border-border px-2 py-1" onClick={() => handles.current.forEach((h) => h?.react(r))}>{r}</button>
          ))}
        </div>
      </header>
      <section className="grid gap-x-4 gap-y-8" style={{ gridTemplateColumns: `repeat(${STATES.length}, minmax(0, 1fr))` }}>
        {NOAH_SHAPES.flatMap((f, row) =>
          STATES.map((s, col) => (
            <Cell key={`${f.id}-${s.id}`} label={`${f.name} · ${s.name}`}>
              <NoahTile
                handle={(h) => {
                  handles.current.set(`${f.id}-${s.id}`, h);
                }}
                color={NOAH_COLORS[(row + col) % NOAH_COLORS.length].hex}
                shape={f.id}
                detail={detail || NOAH_DETAILS[(row + col) % NOAH_DETAILS.length].id}
                state={state ?? s.id}
                seed={`${f.id}-${s.id}`}
                className="size-28"
              />
            </Cell>
          )),
        )}
      </section>
      <section className="flex flex-wrap items-end gap-6">
        {[32, 40, 48, 96, 160].map((px) => (
          <Cell key={px} label={`${px} px`}>
            <span style={{ width: px, height: px, display: "grid" }}>
              <NoahTile color={NOAH_COLORS[3].hex} detail="lunettes" seed={`taille-${px}`} />
            </span>
          </Cell>
        ))}
      </section>
    </div>
  );
}

const AGENT = { agentId: "demo", agentName: "Noah", agentColor: NOAH_COLORS[3].hex, agentShape: params.get("shape") ?? "gomme", agentDetail: params.get("detail") ?? "lunettes", details: false, hint: "Démonstration", conversationId: null, say: () => {}, readOnly: false, canWatch: false };

/** Le vrai écran d'appel, sans Voice.tsx : la phase et les niveaux viennent de la page, comme ils viendront de la voix. */
function CallScene() {
  const [phase, setPhase] = useState("listening");
  const [needsYou, setNeedsYou] = useState(false);
  const mic = useRef({ current: 0 }).current;
  const voice = useRef({ current: 0 }).current;
  useEffect(() => {
    window.noahDemo = { setPhase, setNeedsYou, mic, voice, faces: noahFaces, stats: noahStats };
  }, [mic, voice]);
  return (
    <AgentContext.Provider value={AGENT}>
      <CallStage phase={phase} status={phase} hint="" seconds={12} busy={phase === "waiting"} needsYou={needsYou} muted={false} level={null} micLevel={mic} voiceLevel={params.has("voice") ? voice : undefined} messages={[]} link={(t) => t} extra={null} onMute={() => {}} onInterrupt={() => {}} onHangUp={() => {}} />
    </AgentContext.Provider>
  );
}

/** La vraie conversation avec un modèle factice : la réponse attend `noahDemo.release()`, pour observer le visage pendant le tour. */
function TurnScene() {
  const gate = useRef<() => void>(() => {});
  const runtime = useLocalRuntime({
    async *run() {
      await new Promise<void>((done) => {
        gate.current = done;
      });
      yield { content: [{ type: "text" as const, text: "Voilà, c'est fait." }] };
    },
  });
  useEffect(() => {
    window.noahDemo = { release: () => gate.current(), faces: noahFaces, stats: noahStats };
  }, []);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={AGENT}>
        <div className="h-screen">
          <Thread report={null} onReportRead={() => {}} onCall={() => {}} />
        </div>
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}

type DemoPart = { type: string; [key: string]: unknown };
const tool = (toolName: string, args: Record<string, unknown>, result?: unknown): DemoPart => ({ type: "tool-call", toolCallId: toolName, toolName, args, ...(result === undefined ? {} : { result }) });
const TRACE = tool("trace", { fil: "abc", entete: "Noah m'a demandé", consigne: "Résume les nouveautés de la semaine sur les agents et propose trois angles", etat: "fini", issue: "Trois angles : prix, confiance, vitesse. Le détail et les sources sont dans le fil." }, true);
const TRACE_RUNNING = tool("trace", { fil: "def", entete: "Noah m'a demandé", consigne: "Vérifie les liens du dernier article", etat: "en_cours", issue: "" }, true);
const MOODS: Record<string, { running: boolean; content: DemoPart[] }> = {
  repos: { running: false, content: [{ type: "text", text: "Voilà, c'est fait." }] },
  reflechit: { running: true, content: [] },
  travaille: { running: true, content: [tool("activity", { label: "Lance une commande" })] },
  accord: { running: true, content: [tool("approval", { summary: "rm -rf build", demande: "Ton agent veut lancer une commande.", apercu: ["rm -rf build"], request_id: "r", generation: 1, run_id: "x" })] },
  choix: { running: false, content: [{ type: "text", text: "Lequel préfères-tu ?\n\n```noah\n{\"type\": \"choice\", \"question\": \"Lequel ?\", \"options\": [\"A\", \"B\"]}\n```" }] },
  fini: { running: false, content: [{ type: "text", text: "Voilà, c'est fait." }] },
  erreur: { running: false, content: [tool("error", { message: "L'agent ne répond plus. Il redémarre peut-être : réessaie dans un instant.", detail: "" }, true)] },
};

/** Le message en cours dans chaque humeur, avec les traces d'un fil au-dessus : `noahDemo.mood("travaille")`. */
function MoodScene() {
  const [mood, setMood] = useState(params.get("mood") ?? "reflechit");
  useEffect(() => {
    window.noahDemo = { mood: setMood, faces: noahFaces, active: noahActive, stats: noahStats, setPaused: setNoahPaused };
  }, []);
  const now = MOODS[mood];
  const messages = [
    { id: "t1", role: "assistant", content: [TRACE], status: { type: "complete", reason: "stop" } },
    { id: "t2", role: "assistant", content: [TRACE_RUNNING], status: { type: "complete", reason: "stop" } },
    { id: "a0", role: "assistant", content: [{ type: "text", text: "Une réponse plus ancienne, avec son visage immobile." }], status: { type: "complete", reason: "stop" } },
    { id: "u1", role: "user", content: [{ type: "text", text: "Lance le rapport." }] },
    { id: "a1", role: "assistant", content: now.content, status: now.running ? { type: "running" } : { type: "complete", reason: "stop" } },
  ] as unknown as ThreadMessageLike[];
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages, isRunning: now.running, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={AGENT}>
        <div className="h-screen">
          <Thread report={null} onReportRead={() => {}} onCall={() => {}} />
        </div>
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}

const scene = params.get("scene");
createRoot(document.getElementById("root")!).render(scene === "appel" ? <CallScene /> : scene === "tour" ? <TurnScene /> : scene === "humeurs" ? <MoodScene /> : solo ? <Solo /> : <Gallery />);
