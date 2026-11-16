import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { generateJson, generateText, geminiSchema, modelFor, providerFor } from "../src/index.js";

const KEYS = ["LLM_PROVIDER", "GUARDIAN_LLM_PROVIDER", "GUARDIAN_LLM_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const clear = () => KEYS.forEach((k) => delete process.env[k]);
afterEach(() => { clear(); for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });

const Verdict = z.object({ decision: z.enum(["approve", "deny"]), reason: z.string() });
const gemini = (text: string | undefined, seen: any[] = []) => ({ models: { generateContent: async (req: any) => { seen.push(req); return { text }; } } });

describe("provider selection", () => {
  it("none without keys; gemini preferred when its key is set", () => {
    clear();
    expect(providerFor("agent")).toBe("none");
    process.env.ANTHROPIC_API_KEY = "x";
    expect(providerFor("agent")).toBe("anthropic");
    process.env.GEMINI_API_KEY = "y";
    expect(providerFor("agent")).toBe("gemini");
    expect(modelFor("agent")).toBe("gemini-3.8-flash");
  });
  it("per-role overrides", () => {
    clear();
    process.env.GEMINI_API_KEY = "y";
    process.env.GUARDIAN_LLM_PROVIDER = "none";
    process.env.GUARDIAN_LLM_MODEL = "other-model";
    expect(providerFor("guardian")).toBe("none");
    expect(providerFor("mandate")).toBe("gemini");
    expect(modelFor("guardian", "gemini")).toBe("other-model");
  });
});

describe("gemini JSON path", () => {
  it("sends a JSON schema without $schema and validates the answer", async () => {
    const seen: any[] = [];
    const r = await generateJson(Verdict, { role: "guardian", provider: "gemini", system: "s", user: "u", clients: { gemini: gemini('{"decision":"deny","reason":"churn"}', seen) } });
    expect(r.value).toEqual({ decision: "deny", reason: "churn" });
    expect(seen[0].config.responseMimeType).toBe("application/json");
    expect(seen[0].config.responseJsonSchema.$schema).toBeUndefined();
    expect(seen[0].config.responseJsonSchema.properties.decision.enum).toEqual(["approve", "deny"]);
    expect(seen[0].config.systemInstruction).toBe("s");
  });
  it("returns null (never throws) for non-JSON, off-schema or empty answers", async () => {
    for (const text of ["not json", '{"decision":"maybe","reason":"x"}', undefined]) {
      const r = await generateJson(Verdict, { role: "guardian", provider: "gemini", system: "s", user: "u", clients: { gemini: gemini(text) } });
      expect(r.value).toBeNull();
      expect(r.error).toBeTruthy();
    }
  });
  it("text helper swallows failures", async () => {
    const boom = { models: { generateContent: async () => { throw new Error("quota"); } } };
    expect(await generateText({ role: "agent", provider: "gemini", system: "s", user: "u", clients: { gemini: boom } })).toBeUndefined();
    expect((await generateText({ role: "agent", provider: "gemini", system: "s", user: "u", clients: { gemini: gemini(" hi ") } }))?.text).toBe("hi");
  });
  it("none provider is a no-op", async () => {
    expect((await generateJson(Verdict, { role: "agent", provider: "none", system: "s", user: "u" })).value).toBeNull();
  });
});

it("gemini schema keeps nullable fields expressible", () => {
  const s = geminiSchema(z.object({ schedule: z.string().nullable() }));
  expect(JSON.stringify(s)).toContain("null");
});
