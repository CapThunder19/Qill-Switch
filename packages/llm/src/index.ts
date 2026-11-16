/**
 * One small LLM layer for the three places Qill Switch uses a model (mandate extraction, agent narration,
 * guardian review). The provider comes from the environment:
 *
 *   GEMINI_API_KEY set     → Google Gemini (@google/genai), model GEMINI_MODEL (default gemini-3.8-flash)
 *   ANTHROPIC_API_KEY set  → Claude (@anthropic-ai/sdk), model claude-opus-5-5
 *   neither                → "none": callers fall back to their deterministic path
 *
 * Overrides: LLM_PROVIDER=gemini|anthropic|none for everything, or <ROLE>_LLM_PROVIDER / <ROLE>_LLM_MODEL per role
 * (ROLE = MANDATE | AGENT | GUARDIAN), e.g. a different model for the guardian than for the agent.
 *
 * The model never decides anything on its own: every JSON answer is validated against a Zod schema, and each caller
 * passes it through its own deterministic checks.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { GoogleGenAI } from "@google/genai";

// .env at the repo root (gitignored). Existing environment variables win.
const ENV_FILE = join(resolve(import.meta.dirname, "../../.."), ".env");
if (existsSync(ENV_FILE)) {
  try { process.loadEnvFile(ENV_FILE); } catch { /* malformed .env: ignore, env vars still work */ }
}

export type Provider = "gemini" | "anthropic" | "none";
export type Role = "mandate" | "agent" | "guardian";

export const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", anthropic: "claude-opus-5-5" } as const;

const env = (k: string) => (process.env[k] ?? "").trim() || undefined;

export function providerFor(role: Role): Provider {
  const forced = env(`${role.toUpperCase()}_LLM_PROVIDER`) ?? env("LLM_PROVIDER");
  if (forced === "gemini" || forced === "anthropic" || forced === "none") return forced;
  if (env("GEMINI_API_KEY")) return "gemini";
  if (env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")) return "anthropic";
  return "none";
}

export function modelFor(role: Role, provider: Provider = providerFor(role)): string {
  if (provider === "none") return "none";
  return env(`${role.toUpperCase()}_LLM_MODEL`) ?? (provider === "gemini" ? env("GEMINI_MODEL") ?? DEFAULT_MODELS.gemini : DEFAULT_MODELS.anthropic);
}

/** Injectable clients (tests pass fakes). */
export interface Clients {
  gemini?: { models: { generateContent(req: any): Promise<{ text?: string }> } };
  anthropic?: { beta: { messages: { parse(req: any): Promise<any>; create(req: any): Promise<any> } } };
}
function geminiClient(c?: Clients) {
  if (c?.gemini) return c.gemini;
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}
const anthropicClient = (c?: Clients) => c?.anthropic ?? new Anthropic();

/** Zod → the JSON Schema subset Gemini accepts (drops `$schema`). */
export function geminiSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export interface JsonResult<T> { value: T | null; provider: Provider; model: string; refused?: boolean; error?: string }

/** Structured output validated against `schema`. Returns value=null (never throws) if the model's answer doesn't fit. */
export async function generateJson<T>(schema: z.ZodType<T>, opts: { role: Role; system: string; user: string; clients?: Clients; provider?: Provider }):
  Promise<JsonResult<T>> {
  const provider = opts.provider ?? providerFor(opts.role);
  const model = modelFor(opts.role, provider);
  if (provider === "none") return { value: null, provider, model, error: "no LLM configured" };

  if (provider === "gemini") {
    const r = await geminiClient(opts.clients).models.generateContent({
      model,
      contents: opts.user,
      config: { systemInstruction: opts.system, responseMimeType: "application/json", responseJsonSchema: geminiSchema(schema) },
    });
    if (!r.text) return { value: null, provider, model, error: "empty response (possibly blocked)" };
    let raw: unknown;
    try { raw = JSON.parse(r.text); } catch { return { value: null, provider, model, error: "response was not JSON" }; }
    const parsed = schema.safeParse(raw);
    return parsed.success ? { value: parsed.data, provider, model } : { value: null, provider, model, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }

  const r = await anthropicClient(opts.clients).beta.messages.parse({
    model,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(schema as any) },
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  if (r.stop_reason === "refusal") return { value: null, provider, model, refused: true, error: r.stop_details?.explanation ?? "refusal" };
  return r.parsed_output ? { value: r.parsed_output as T, provider, model } : { value: null, provider, model, error: `no parsable output (${r.stop_reason})` };
}

/** Free text (short explanations). Returns undefined on any failure: callers treat text as cosmetic. */
export async function generateText(opts: { role: Role; system: string; user: string; clients?: Clients; provider?: Provider }):
  Promise<{ text: string; provider: Provider; model: string } | undefined> {
  const provider = opts.provider ?? providerFor(opts.role);
  const model = modelFor(opts.role, provider);
  if (provider === "none") return undefined;
  try {
    if (provider === "gemini") {
      const r = await geminiClient(opts.clients).models.generateContent({ model, contents: opts.user, config: { systemInstruction: opts.system } });
      return r.text ? { text: r.text.trim(), provider, model } : undefined;
    }
    const r = await anthropicClient(opts.clients).beta.messages.create({
      model, max_tokens: 1000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low" }, system: opts.system, messages: [{ role: "user", content: opts.user }],
    });
    if (r.stop_reason === "refusal") return undefined;
    const text = r.content.flatMap((c: any) => (c.type === "text" ? [c.text] : [])).join(" ").trim();
    return text ? { text, provider, model } : undefined;
  } catch {
    return undefined;
  }
}
