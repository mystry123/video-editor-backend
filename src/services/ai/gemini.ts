// services/ai/gemini.ts
//
// Gemini on Vertex AI: one generateContent call with optional tools. The
// credentials come from the environment (Application Default Credentials:
// `gcloud auth application-default login` locally, workload identity on
// servers), never from a key in the repo. Tests swap the client with
// setGeminiClient().

import { GoogleAuth } from 'google-auth-library';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';

export interface GeminiMessage {
  role: 'user' | 'model';
  text: string;
}

/** A function the model may call; `parameters` is a Vertex (OpenAPI-subset) schema */
export interface GeminiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiRequest {
  model: string;
  system: string;
  messages: GeminiMessage[];
  tools?: GeminiTool[];
  temperature?: number;
}

export interface GeminiResult {
  /** The model that answered (another one if the asked one was over its limit) */
  model?: string;
  text: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  usage: { input: number; output: number };
}

export interface GeminiClient {
  generate(request: GeminiRequest): Promise<GeminiResult>;
}

// The project is given so the library never has to look it up (that needs the
// Cloud Resource Manager API, and keyless AWS sign-in triggers the lookup)
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: env.vertexProject });

/**
 * Gemini 3 and later are tuned for temperature 1 (lower makes them loop or
 * degrade, per Google); older models do best low for tool use.
 */
export function temperatureFor(model: string, asked?: number): number {
  if (/^gemini-([3-9]|\d\d)/.test(model)) return 1;
  return asked ?? 0.2;
}

const unavailable = () =>
  ApiError.withCode(503, 'ASSISTANT_UNAVAILABLE', "The assistant isn't available right now. Try again in a minute.");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RateLimited extends Error {}

const vertexClient: GeminiClient = {
  /** Over the rate limit: one short retry, then the fallback model */
  async generate(request) {
    const fallback = env.aiModelFallback && env.aiModelFallback !== request.model ? env.aiModelFallback : null;
    for (const [attempt, model] of [request.model, request.model, ...(fallback ? [fallback] : [])].entries()) {
      try {
        return { ...(await callVertex({ ...request, model })), model };
      } catch (error) {
        if (!(error instanceof RateLimited)) throw error;
        logger.warn('Vertex rate limited', { model, attempt });
        if (attempt === 0) await sleep(1500);
      }
    }
    throw ApiError.withCode(503, 'ASSISTANT_BUSY', 'Cue is busy right now. Try again in a minute.');
  },
};

async function callVertex({ model, system, messages, tools, temperature }: GeminiRequest): Promise<GeminiResult> {
  {
    let token: string | null | undefined;
    try {
      token = await auth.getAccessToken();
    } catch (error) {
      logger.error('Vertex credentials unavailable', { error: (error as Error).message });
      throw unavailable();
    }
    const host = env.vertexLocation === 'global' ? 'aiplatform.googleapis.com' : `${env.vertexLocation}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${env.vertexProject}/locations/${env.vertexLocation}/publishers/google/models/${model}:generateContent`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
          ...(tools?.length
            ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
            : {}),
          generationConfig: { temperature: temperatureFor(model, temperature) },
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      logger.error('Vertex unreachable', { error: (error as Error).message });
      throw unavailable();
    }
    if (response.status === 429) throw new RateLimited();
    if (!response.ok) {
      logger.error('Vertex request failed', { status: response.status, body: (await response.text()).slice(0, 500), model });
      throw unavailable();
    }
    const body = (await response.json()) as any;
    const parts: any[] = body.candidates?.[0]?.content?.parts ?? [];
    return {
      // Thought summaries (if any) aren't part of the reply
      text: parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim(),
      calls: parts.filter((p) => p.functionCall).map((p) => ({ name: String(p.functionCall.name), args: p.functionCall.args ?? {} })),
      usage: { input: Number(body.usageMetadata?.promptTokenCount) || 0, output: Number(body.usageMetadata?.candidatesTokenCount) || 0 },
    };
  }
}

let override: GeminiClient | null = null;

export function getGeminiClient(): GeminiClient {
  return override ?? vertexClient;
}

/** Tests: use `client` instead (null goes back to Vertex). */
export function setGeminiClient(client: GeminiClient | null): void {
  override = client;
}
