import type { ChatMessage, ChatRequest } from "../types.ts";

/**
 * Text-protocol tool calling for backends that only return text (the OpenCode
 * sidecar). The caller's tool definitions go into the system text, the model
 * answers with <tool_call>{...}</tool_call> blocks, and we turn those back
 * into OpenAI `tool_calls`. Earlier tool calls and results in the
 * conversation are rendered the same way so the model sees a consistent
 * transcript.
 */

export interface EmulatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParsedToolOutput {
  content: string;
  toolCalls: EmulatedToolCall[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

function toolSpecs(tools: unknown[] | undefined): ToolSpec[] {
  if (!Array.isArray(tools)) return [];
  const specs: ToolSpec[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    specs.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return specs;
}

/** Tool names the request allows, honoring tool_choice "none" and a forced function. */
export function activeTools(request: ChatRequest): ToolSpec[] {
  const specs = toolSpecs(request.tools);
  const choice = request.tool_choice;
  if (choice === "none") return [];
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return specs.filter((spec) => spec.name === (choice.function as UnknownRecord).name);
  }
  return specs;
}

export function toolInstructions(request: ChatRequest): string {
  const specs = activeTools(request);
  if (specs.length === 0) return "";
  const required = request.tool_choice === "required" || isRecord(request.tool_choice);
  const lines = [
    "# Host tools",
    "You are running inside a host application that runs tools for you.",
    "Your own built-in tools (bash, read, write, edit, glob, grep, list, webfetch, task, todo and any others) are switched off: every call to them is rejected. Do not call them.",
    "To use a host tool, reply with one or more blocks in exactly this form and nothing after the last block:",
    '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    "`arguments` must be a JSON object that matches the tool's parameters. The host runs the calls and sends each result back as a message that starts with `tool result`.",
    "When no tool is needed, answer normally in plain text with no <tool_call> block.",
    ...(required ? ["You must call a tool in this reply."] : []),
    "",
    "Available host tools:",
  ];
  for (const spec of specs) {
    lines.push(`## ${spec.name}`);
    if (spec.description) lines.push(spec.description);
    lines.push(`parameters: ${JSON.stringify(spec.parameters)}`);
  }
  return lines.join("\n");
}

function callText(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  const fn = isRecord(call.function) ? call.function : undefined;
  const name = fn && typeof fn.name === "string" ? fn.name : undefined;
  if (!name) return undefined;
  let args: unknown = {};
  if (fn && typeof fn.arguments === "string") {
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      args = fn.arguments;
    }
  } else if (fn && fn.arguments !== undefined) {
    args = fn.arguments;
  }
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

/** Render an assistant message's tool_calls as protocol blocks. */
export function renderAssistantToolCalls(message: ChatMessage): string {
  if (!Array.isArray(message.tool_calls)) return "";
  return message.tool_calls.map(callText).filter((text): text is string => Boolean(text)).join("\n");
}

export function renderToolResultPrefix(message: ChatMessage): string {
  const name = typeof message.name === "string" && message.name ? ` ${message.name}` : "";
  const id = typeof message.tool_call_id === "string" && message.tool_call_id ? ` (${message.tool_call_id})` : "";
  return `tool result${name}${id}: `;
}

let counter = 0;
function callId(): string {
  counter = (counter + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toCall(value: unknown, allowed: Set<string>): EmulatedToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || !allowed.has(name)) return undefined;
  let args = value.arguments ?? value.parameters ?? value.input ?? {};
  if (typeof args === "string") args = tryJson(args) ?? {};
  if (!isRecord(args)) return undefined;
  return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const TAGGED = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const FENCED = /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g;

/**
 * Pull protocol tool calls out of model text. Only names the request offered
 * count; anything else stays as text. Text before the first call is kept as
 * content.
 */
export function parseToolOutput(text: string, request: ChatRequest): ParsedToolOutput {
  const specs = activeTools(request);
  if (specs.length === 0) return { content: text, toolCalls: [] };
  const allowed = new Set(specs.map((spec) => spec.name));
  const calls: EmulatedToolCall[] = [];
  let firstIndex = -1;
  for (const match of text.matchAll(TAGGED)) {
    const call = toCall(tryJson(match[1]), allowed);
    if (!call) continue;
    calls.push(call);
    if (firstIndex === -1) firstIndex = match.index ?? 0;
  }
  if (calls.length === 0) {
    for (const match of text.matchAll(FENCED)) {
      const call = toCall(tryJson(match[1]), allowed);
      if (!call) continue;
      calls.push(call);
      if (firstIndex === -1) firstIndex = match.index ?? 0;
    }
  }
  if (calls.length === 0) {
    const whole = toCall(tryJson(text.trim()), allowed);
    if (whole) return { content: "", toolCalls: [whole] };
    return { content: text, toolCalls: [] };
  }
  return { content: text.slice(0, firstIndex).trim(), toolCalls: calls };
}
