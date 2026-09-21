export type BackendId = "opencode" | "kilo" | "mimo";
export type Capability = "text" | "image" | "tools" | "reasoning";

export interface BackendModel {
  id: string;
  backend: BackendId;
  name: string;
  capabilities: Capability[];
  contextWindow: number;
  maxTokens: number;
  healthy: boolean;
  source: "static" | "discovered";
}

export interface BackendHealth {
  backend: BackendId;
  configured: boolean;
  healthy: boolean;
  checkedAt: string;
  reason?: string;
  latencyMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface BackendAdapter {
  readonly id: BackendId;
  listModels(signal?: AbortSignal): Promise<BackendModel[]>;
  health(signal?: AbortSignal): Promise<BackendHealth>;
  complete(request: ChatRequest, model: BackendModel, signal: AbortSignal): Promise<Response>;
}
