/**
 * Guardian service: a separate process (localhost only) that co-signs trades above the soft limit with the guardian
 * ML-DSA-87 key, or vetoes them. It never grants power: its signature is required IN ADDITION to the mandate, and the
 * vault still enforces every cap.
 *
 *   POST /review  { deployment, trade: {mandateId,pool,tokenIn,tokenOut,amountIn,minOut}, reasoning? }
 *   → { approved, reasons[], review, guardianAuth? }
 *   GET  /health
 *
 *   pnpm guardian           (port GUARDIAN_PORT, default 8787)
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { REPO_ROOT, publicClient as pub, VAULT_ABI, signGuardianApproval, type TradeParams } from "@qill/chain";
import { evaluate, type GuardianFacts } from "./policy.js";
import { llmReview, guardianModel } from "./review.js";
import { providerFor } from "@qill/llm";

const PORT = Number(process.env.GUARDIAN_PORT?.trim() || 8787);
const LOG = join(REPO_ROOT, "logs", "guardian.jsonl");
const POOL_ABI = parseAbi(["function quote(address,address,uint256) view returns (uint256)", "function reserve0() view returns (uint256)", "function reserve1() view returns (uint256)", "function token0() view returns (address)"]);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function log(e: Record<string, unknown>) {
  mkdirSync(join(REPO_ROOT, "logs"), { recursive: true });
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }, big) + "\n");
}
function history(mandateId: string): { approvals: number[]; recent: unknown[] } {
  if (!existsSync(LOG)) return { approvals: [], recent: [] };
  const rows = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.mandateId === mandateId);
  return {
    approvals: rows.filter((r) => r.approved).map((r) => Math.floor(Date.parse(r.ts) / 1000)),
    recent: rows.slice(-10).map((r) => ({ ts: r.ts, approved: r.approved, amountIn: r.trade?.amountIn, reasons: r.reasons })),
  };
}

async function review(body: any) {
  const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${body.deployment ?? "demo"}.json`), "utf8"));
  const vault = dep.contracts.QillVault as Address;
  const t: TradeParams = {
    mandateId: body.trade.mandateId as Hex, pool: body.trade.pool, tokenIn: body.trade.tokenIn, tokenOut: body.trade.tokenOut,
    amountIn: BigInt(body.trade.amountIn), minOut: BigInt(body.trade.minOut),
  };
  const read = (fn: string, a: unknown[] = []) => pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args: a });

  // facts from chain, never from the request
  const [, , expiry, status, pools, tokens] = (await read("getMandate", [t.mandateId])) as [Hex, Hex, bigint, number, Address[], Address[]];
  const [perTradeCap, dailyCap, softLimit, spentToday, dayIndex] = (await read("limits", [t.mandateId, t.tokenIn])) as bigint[];
  let quote = 0n, spotOut = 0n;
  try {
    quote = (await pub.readContract({ address: t.pool, abi: POOL_ABI, functionName: "quote", args: [t.tokenIn, t.tokenOut, t.amountIn] })) as bigint;
    const [r0, r1, t0] = await Promise.all(["reserve0", "reserve1", "token0"].map((fn) => pub.readContract({ address: t.pool, abi: POOL_ABI, functionName: fn as any })));
    const [rin, rout] = (t0 as string).toLowerCase() === t.tokenIn.toLowerCase() ? [r0 as bigint, r1 as bigint] : [r1 as bigint, r0 as bigint];
    spotOut = rin === 0n ? 0n : (t.amountIn * rout) / rin;
  } catch { /* unknown pool: quote stays 0 → denied */ }
  const h = history(t.mandateId);
  const facts: GuardianFacts = {
    now: Math.floor(Date.now() / 1000),
    mandate: { status: Number(status), expiry, pools, tokens },
    limits: { perTradeCap: perTradeCap!, dailyCap: dailyCap!, softLimit: softLimit!, spentToday: spentToday!, dayIndex: dayIndex! },
    trade: t, quote, spotOut, recentApprovals: h.approvals,
  };
  const policy = evaluate(facts);
  const out: Record<string, unknown> = { mandateId: t.mandateId, vault, trade: t, approved: false, reasons: policy.reasons };

  if (!policy.approve) { log({ ...out, stage: "policy" }); return out; }

  // independent judgement (veto only)
  const mf = join(REPO_ROOT, "mandates", `${t.mandateId}.json`);
  const mandateText = existsSync(mf) ? JSON.parse(readFileSync(mf, "utf8")).text : "(mandate text unavailable)";
  const rev = await llmReview({ mandateText, trade: t, facts: { quote, spotOut, perTradeCap, dailyCap, softLimit, spentToday }, agentReasoning: body.reasoning, history: h.recent });
  out.review = rev;
  if ("decision" in rev && rev.decision === "deny") { out.reasons = [`guardian review: ${rev.reason}`]; log({ ...out, stage: "review" }); return out; }

  // final check: the exact trade with this exact approval must succeed when called by the executor
  const guardianAuth = await signGuardianApproval(vault, t);
  const executor = (await read("executor")) as Address;
  try {
    await pub.call({ account: executor, to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "trade", args: [t, guardianAuth] }) });
  } catch (e: any) {
    out.reasons = [`simulation with approval reverted: ${e.shortMessage ?? e.message}`];
    log({ ...out, stage: "simulation" });
    return out;
  }
  out.approved = true;
  out.reasons = [];
  out.guardianAuth = guardianAuth;
  log({ ...out, guardianAuth: { nonce: guardianAuth.nonce, expiry: guardianAuth.expiry }, stage: "approved" });
  return out;
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body, big)); };
  try {
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, review: guardianModel(), llm: providerFor("guardian") !== "none" });
    if (req.method !== "POST" || req.url !== "/review") return send(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) return send(413, { error: "too large" }); }
    send(200, await review(JSON.parse(raw)));
  } catch (e: any) {
    send(500, { approved: false, reasons: [`guardian error: ${e.message}`] });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`guardian listening on 127.0.0.1:${PORT} (LLM review: ${providerFor("guardian") === "none" ? "off, deterministic policy only" : guardianModel()})`);
});
