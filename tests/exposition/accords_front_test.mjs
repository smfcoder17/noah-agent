// #36, suite 3 : exécute le calcul du fil et le rendu d'À toi, sans navigateur ni réseau.
// React et les effets sont remplacés à la frontière ; le code TypeScript testé est celui de l'app.
//   node tests/exposition/accords_front_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(path, imports) {
  const file = fileURLToPath(new URL(`../../frontend/src/${path}`, import.meta.url));
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${source}\n})`, { filename: file }).runInThisContext()(
    (id) => Object.hasOwn(imports, id) ? imports[id] : require(id), module, module.exports,
  );
  return module.exports;
}
function hooks(first) {
  let state = 0;
  return {
    ...React, useState: (initial) => [state++ === 0 ? first : typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (current) => ({ current }), useEffect: () => {}, useMemo: (calculate) => calculate(), useCallback: (fn) => fn,
  };
}
const { accordLabel } = load("lib/events.ts", { "./api": {}, react: React });
assert.equal(accordLabel({ etat: "expire" }), null);
assert.equal(accordLabel({ etat: "annule" }), null);

const approval = (id, result) => ({ type: "tool-call", toolCallId: id, toolName: "approval", args: {}, ...(result !== undefined ? { result } : {}) });
const history = [{ id: "ancien-fil", role: "assistant", content: [
  { type: "text", text: "Travail précédent" }, approval("ancien-donne", "approved"), approval("ancien-refuse", "denied"),
  approval("resultat-faux", false), approval("carte-perimee"),
] }];
const { useAgentChat } = load("lib/useAgentChat.ts", {
  react: hooks(history), "./api": {},
  "@assistant-ui/react": { useExternalStoreRuntime: (config) => config },
  "./events": { accordLabel, useAccords: () => ({
    items: [{ id: "premiere", conv_id: "fil" }, { id: "autre-fil", conv_id: "autre" }],
    recent: [
      { id: "expire", conv_id: "fil", etat: "expire" }, { id: "annule", conv_id: "fil", etat: "annule" },
      { id: "donne", conv_id: "fil", etat: "donne", par: "ordinateur" },
      { id: "refuse", conv_id: "fil", etat: "refuse", par: "téléphone" },
    ],
  }) },
});
const { runtime } = useAgentChat({ agentId: "a1", conversationId: "fil", details: false });
const shown = runtime.messages;
assert.deepEqual(shown[0].content.map((p) => p.toolCallId ?? p.text), ["Travail précédent", "ancien-donne", "ancien-refuse", "resultat-faux"]);
assert.deepEqual(shown.filter((m) => m.id.startsWith("accord-")).map((m) => m.id), ["accord-premiere"]);
assert.deepEqual(shown.filter((m) => m.id.startsWith("clos-")).map((m) => m.content[0].text), [
  "Accord donné sur l'ordinateur", "Accord refusé sur le téléphone",
]);
console.log("OK #36 fil : résultats anciens conservés, carte périmée retirée, bon fil, expiration/annulation silencieuses");

const item = (id, created, etat = "choice") => ({ id, created, etat, conversation_id: id, demande: id, agent: "Noah", apercu: [] });
const rows = [item("choix-recent", 40), item("choix-ancien", 10)];
const accords = [item("accord-milieu", 20, "approve"), item("accord-recent", 50, "approve")];
const children = ({ children }) => React.createElement("div", null, children);
const { Inbox } = load("components/Inbox.tsx", {
  react: hooks(rows), "@/lib/api": {}, "@/lib/events": { useAccords: () => ({ items: accords }) },
  "./ui": { Dialog: children, DialogContent: children, ErrorText: children, Button: children },
  "./Noah": { AgentFace: () => null }, "./Sidebar": { StateShape: () => null }, "./LoginCard": { LoginCard: () => null },
});
const html = renderToStaticMarkup(React.createElement(Inbox, { open: true, agents: [] }));
const order = [...html.matchAll(/aria-label="Ouvrir la conversation : ([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(order, ["choix-ancien", "accord-milieu", "choix-recent", "accord-recent"]);
assert.deepEqual(rows.map((r) => r.id), ["choix-recent", "choix-ancien"]);
assert.deepEqual(accords.map((r) => r.id), ["accord-milieu", "accord-recent"]);
console.log("OK #36 À toi : accords et choix intercalés par date d'arrivée, sans modifier leurs listes sources");
