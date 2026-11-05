// Outils du parcours de la bulle Android : adb, et les pages de l'app par le protocole de débogage de sa WebView (APK de débogage).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ADB = process.env.LOCALAPPDATA + "/Android/Sdk/platform-tools/adb.exe";
const ENV = { ...process.env, MSYS_NO_PATHCONV: "1" };
export const APP = "agent.noah.mobile";
export const SERVER_FROM_PHONE = "http://10.0.2.2:18099";
export const SERVER = "http://127.0.0.1:18099";

/** Machine chargée : le démon d'adb tombe parfois. Ce n'est pas un échec du parcours : on le relance. */
export function adb(...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(ADB, args, { encoding: "utf8", env: ENV, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) {
      if (attempt >= 5 || !/daemon/.test(String(e.stderr))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function screenshot(path) {
  writeFileSync(path, execFileSync(ADB, ["exec-out", "screencap", "-p"], { env: ENV, maxBuffer: 1 << 27 }));
}

export async function essai(method, path, body) {
  const r = await fetch(SERVER + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

/** Évalue du JavaScript dans la page de l'app. Une connexion par appel : la page peut avoir été rechargée entre deux. */
export async function page(expression, { port = 9334 } = {}) {
  const pid = adb("shell", "pidof", APP);
  adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page" && t.description.includes('"attached":true')) ?? targets[0];
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    socket.onopen = ok;
    socket.onerror = no;
  });
  const answer = new Promise((ok, no) => {
    socket.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.id !== 1) return;
      if (data.result?.exceptionDetails) no(new Error(JSON.stringify(data.result.exceptionDetails).slice(0, 400)));
      else ok(data.result?.result?.value);
    };
  });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  const value = await answer;
  socket.close();
  return value;
}

/** Attend qu'une expression de la page soit vraie. */
export async function until(expression, label, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      if (await page(expression)) return;
    } catch (e) {
      last = e; // page en plein rechargement
    }
    await sleep(500);
  }
  throw new Error(`jamais vu : ${label} ${last ?? ""}`);
}

export const clickText = (text, tag = "button,[role=tab],label") =>
  page(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim().includes(${JSON.stringify(text)})); if (!e) return false; for (const t of ['pointerdown','mousedown','pointerup','mouseup']) e.dispatchEvent(new (t.startsWith('p') ? PointerEvent : MouseEvent)(t, { bubbles: true, button: 0 })); e.click(); return true; })()`);

/** La fenêtre système au premier plan et ce qu'elle affiche : uiautomator, le seul regard possible sur les autres apps et sur les écrans système. */
export function nativeTree() {
  adb("shell", "uiautomator", "dump", "/sdcard/noah-ui.xml");
  return adb("shell", "cat", "/sdcard/noah-ui.xml");
}

export function nodeBounds(tree, text) {
  const nodes = tree.match(/<node [^>]*>/g) ?? [];
  const n = nodes.find((x) => x.includes(`text="${text}"`) || x.includes(`content-desc="${text}"`));
  const m = n?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  return m ? { x: (Number(m[1]) + Number(m[3])) >> 1, y: (Number(m[2]) + Number(m[4])) >> 1 } : null;
}

export function tapNative(text) {
  const at = nodeBounds(nativeTree(), text);
  if (!at) throw new Error(`rien à l'écran : ${text}`);
  adb("shell", "input", "tap", String(at.x), String(at.y));
}
