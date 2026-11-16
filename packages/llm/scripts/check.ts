/**
 * pnpm llm:check: which provider/model each role uses, which Gemini models this key can call, and one tiny structured
 * call per role. Never prints the key.
 */
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import { generateJson, modelFor, providerFor, type Role } from "../src/index.js";

const roles: Role[] = ["mandate", "agent", "guardian"];
for (const r of roles) console.log(`${r.padEnd(9)} → ${providerFor(r)} ${modelFor(r)}`);

if (process.env.GEMINI_API_KEY) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const names: string[] = [];
  try {
    for await (const m of await ai.models.list()) if (m.supportedActions?.includes("generateContent")) names.push(String(m.name).replace(/^models\//, ""));
    const flash = names.filter((n) => /flash/.test(n)).sort().reverse();
    console.log(`\nGemini models available to this key (${names.length} with generateContent); flash models:\n  ${flash.slice(0, 12).join("\n  ")}`);
    const chosen = modelFor("mandate", "gemini");
    if (!names.includes(chosen)) console.log(`\n!! ${chosen} is not in this key's list. Set GEMINI_MODEL in .env to one of the models above.`);
  } catch (e: any) {
    console.log(`\nCould not list models: ${e.message}`);
  }
}

const Ping = z.object({ ok: z.boolean(), word: z.string() });
for (const role of roles) {
  if (providerFor(role) === "none") { console.log(`${role}: no LLM configured (deterministic path only)`); continue; }
  const t0 = Date.now();
  try {
    const r = await generateJson(Ping, { role, system: "Answer with JSON only.", user: 'Return {"ok": true, "word": "qill"}.' });
    console.log(`${role}: ${r.value ? `OK ${JSON.stringify(r.value)}` : `FAILED ${r.error}`} (${r.provider} ${r.model}, ${Date.now() - t0} ms)`);
  } catch (e: any) {
    console.log(`${role}: ERROR ${e.message}`);
  }
}
