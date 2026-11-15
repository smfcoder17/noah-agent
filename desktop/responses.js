// Traduction Chat Completions ↔ API Responses, pour le forfait ChatGPT de la personne (voie officielle « Sign in with ChatGPT »).
// Les agents Noah parlent Chat Completions ; le forfait n'accepte que l'API Responses, avec store:false et stream:true.
//
// Provenance : adapté d'OmniRoute (https://github.com/cheaper-inference/OmniRoute, commit 418cf3439b88a6318210bb1c819d55f6aa8513ee),
//   - open-sse/executors/chatgpt.ts : prepareChatGptRequest, OMIT_FIELDS, ALLOWED_TOOLS, checkTools (outils du client
//     passés par un élément « additional_tools ») ;
//   - open-sse/translator/request/openai-responses/toResponses.ts : buildInstructionsText, buildResponsesTextParts,
//     repairToolHistory, mapChatResponseFormatToResponsesText.
// Réécrit en JavaScript sans dépendance ; le sens Responses → Chat Completions est écrit pour Noah.
// Rien des parties d'OmniRoute qui imitent un client officiel (empreintes, en-têtes copiés, Codex, backend-api) n'est repris.
//
// MIT License
//
// Copyright (c) 2026 diegosouzapw
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Champs que cette voie refuse (liste d'OmniRoute, conforme à « Preview limitations » d'OpenAI).
const OMIT_FIELDS = ["background", "conversation", "max_output_tokens", "max_tokens", "max_completion_tokens", "max_tool_calls", "metadata",
  "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation",
  "user", "previous_response_id"];
const ALLOWED_TOOLS = new Set(["function", "custom", "namespace"]); // sans les outils hébergés : Noah garde les siens

const text = (v) => (typeof v === "string" ? v : "");

/** Contenu d'un message système ou développeur → le texte unique d'`instructions` (buildInstructionsText). */
function instructionsText(content) {
  if (typeof content === "string") return content;
  return textParts(content).map((p) => p.text).filter(Boolean).join("\n\n");
}

/** Contenu d'un message → parties input_text / input_image (buildResponsesTextParts, avec les images). */
function textParts(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: "" }];
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push({ type: "input_text", text: part });
    else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url, ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}) });
    } else if (part && (part.type === "text" || typeof part.text === "string")) parts.push({ type: "input_text", text: text(part.text) });
  }
  return parts.length ? parts : [{ type: "input_text", text: "" }];
}

/** Retire les résultats d'outil sans appel, et donne un résultat vide à un appel resté sans réponse (repairToolHistory). */
function repairToolHistory(input) {
  const calls = new Set(input.filter((i) => i.type === "function_call" && i.call_id).map((i) => i.call_id));
  const kept = input.filter((i) => i.type !== "function_call_output" || !i.call_id || calls.has(i.call_id));
  const answered = new Set(kept.filter((i) => i.type === "function_call_output").map((i) => i.call_id));
  const out = [];
  for (const item of kept) {
    out.push(item);
    if (item.type === "function_call" && !answered.has(item.call_id)) {
      out.push({ type: "function_call_output", call_id: item.call_id, output: "" });
      answered.add(item.call_id);
    }
  }
  return out;
}

function checkTools(tools, depth = 0) {
  if (!Array.isArray(tools) || depth > 5) throw new Error("invalid tools");
  for (const tool of tools) {
    if (!ALLOWED_TOOLS.has(String(tool?.type))) throw new Error(`unsupported tool type: ${String(tool?.type).slice(0, 60)}`);
    if (tool.type === "namespace") checkTools(tool.tools, depth + 1);
  }
}

/** Corps Chat Completions de l'agent → corps de l'API Responses pour ce modèle. */
function toResponses(body, model) {
  const instructions = [];
  const input = [];
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;
    if (role === "system" || role === "developer") {
      const t = instructionsText(msg.content);
      if (t) instructions.push(t);
    } else if (role === "user") {
      input.push({ type: "message", role: "user", content: textParts(msg.content) });
    } else if (role === "assistant") {
      const said = typeof msg.content === "string" ? msg.content : textParts(msg.content).map((p) => p.text || "").join("");
      if (said) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: said }] });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        if (!call?.function?.name) continue;
        const args = call.function.arguments;
        input.push({ type: "function_call", call_id: String(call.id || ""), name: call.function.name,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
      }
    } else if (role === "tool") {
      const output = typeof msg.content === "string" ? msg.content : textParts(msg.content).map((p) => p.text || "").join("\n");
      input.push({ type: "function_call_output", call_id: String(msg.tool_call_id || ""), output });
    }
  }
  const out = { model, store: false, stream: true, input: repairToolHistory(input) };
  if (instructions.length) out.instructions = instructions.join("\n\n");
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.type === "function" && t.function?.name).map((t) => ({
    type: "function", name: t.function.name, description: text(t.function.description),
    parameters: t.function.parameters || { type: "object", properties: {} }, strict: false,
  }));
  if (tools.length) {
    checkTools(tools);
    // Outils du client : par un élément « additional_tools » en tête de l'entrée, comme le fait OmniRoute.
    out.input.unshift({ type: "additional_tools", tools });
    if (typeof body.tool_choice === "string") out.tool_choice = body.tool_choice;
    else if (body.tool_choice?.function?.name) out.tool_choice = { type: "function", name: body.tool_choice.function.name };
    if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.reasoning_effort === "string") out.reasoning = { effort: body.reasoning_effort };
  const format = body.response_format;
  if (format?.type === "json_object") out.text = { format: { type: "json_object" } };
  else if (format?.type === "json_schema" && format.json_schema?.schema) {
    out.text = { format: { type: "json_schema", name: text(format.json_schema.name) || "sortie", schema: format.json_schema.schema,
      ...(format.json_schema.strict !== undefined ? { strict: format.json_schema.strict } : {}) } };
  }
  for (const key of OMIT_FIELDS) delete out[key];
  return out;
}

/** Réponse terminée de l'API Responses → réponse Chat Completions, pour l'agent. */
function toChat(response, model) {
  let content = "";
  const toolCalls = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item.type === "message") {
      for (const part of item.content || []) if (part.type === "output_text") content += text(part.text);
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      toolCalls.push({ id: text(item.call_id) || text(item.id), type: "function",
        function: { name: text(item.name), arguments: typeof item.arguments === "string" ? item.arguments : text(item.input) || "{}" } });
    }
  }
  const usage = response?.usage || {};
  const message = { role: "assistant", content: content || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: text(response?.id) || "chatgpt",
    object: "chat." + "completion", // coupé : la forme d'une clé de texte
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : response?.status === "incomplete" ? "length" : "stop" }],
    usage: {
      prompt_tokens: Number(usage.input_tokens) || 0,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
      prompt_tokens_details: { cached_tokens: Number(usage.input_tokens_details?.cached_tokens) || 0 },
    },
  };
}

module.exports = { toResponses, toChat, repairToolHistory, OMIT_FIELDS };
