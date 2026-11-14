/**
 * Qill treasury agent.
 *
 * Each step: fail-closed safety check → find the active mandate → read pool price and vault balances →
 * deterministic rebalance decision (sized inside the mandate's per-trade cap, remaining daily cap and soft limit)
 * → optional LLM reasoning note → agent-signed MsgExecuteEVM via the relayer → verify (no
 * abstractaccount_execution_failed, TradeExecuted event or balance delta) → append to logs/agent.jsonl.
 *
 * The LLM never chooses amounts, tokens or pools; it only explains the decision in plain English.
 *
 *   pnpm agent --once            one step
 *   pnpm agent --interval 60     loop
 *   pnpm agent --once --dry      decide but do not submit
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { encodeFunctionData, formatUnits, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  REPO_ROOT, loadAccount, publicClient as pub, VAULT_ABI, agentExecuteEvm, loadOrCreateLinkKey, TxFailed,
} from "@qill/chain";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ONCE = args.includes("--once");
const DRY = args.includes("--dry");
const INTERVAL = Number(opt("--interval") ?? 60);
const DEPLOYMENT = opt("--deployment") ?? "demo";
const DRIFT_BPS = BigInt(opt("--drift-bps") ?? 200); // rebalance when >2% away from 50/50 (demo knob)
const ONE = 10n ** 18n;

const dep = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${DEPLOYMENT}.json`), "utf8"));
const VAULT = dep.contracts.QillVault as Address;
const POOL = dep.contracts.MockPool as Address;
const TOK: Record<string, Address> = { QTA: dep.contracts.TokenA, QTB: dep.contracts.TokenB };
const SYM = (a: string) => Object.entries(TOK).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? a;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const POOL_ABI = parseAbi(["function quote(address,address,uint256) view returns (uint256)", "function reserve0() view returns (uint256)", "function reserve1() view returns (uint256)", "function token0() view returns (address)"]);
const LOG_DIR = join(REPO_ROOT, "logs");

const v = (fn: string, a: unknown[] = []) => pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: fn, args: a });

function log(entry: Record<string, unknown>) {
  mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), deployment: DEPLOYMENT, vault: VAULT, ...entry }, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  appendFileSync(join(LOG_DIR, "agent.jsonl"), line + "\n");
  console.log(line);
}

// ------------------------------------------------------------------ safety

/** Fail closed: any read error or any stop flag → do nothing. */
async function safetyCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const [paused, frozen, executor] = await Promise.all([v("paused"), v("qDayFrozen"), v("executor")]);
    if (frozen) return { ok: false, reason: "vault is Q-Day frozen" };
    if (paused) return { ok: false, reason: "vault is paused (STOP)" };
    const smart = loadAccount("agentacct");
    if ((executor as string).toLowerCase() !== smart.evm.toLowerCase()) return { ok: false, reason: "this agent is not the vault executor" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `cannot read vault state (${e.shortMessage ?? e.message}); failing closed` };
  }
}

// ------------------------------------------------------------------ mandate

interface ActiveMandate {
  id: Hex; expiry: bigint; pools: Address[]; tokens: Address[]; template: string; schedule: string | null; text: string;
  limits: Record<string, { perTradeCap: bigint; dailyCap: bigint; softLimit: bigint; spentToday: bigint; dayIndex: bigint }>;
}
async function activeMandate(): Promise<ActiveMandate | null> {
  const n = Number(await v("mandateCount"));
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let i = n - 1; i >= 0; i--) {
    const id = (await v("mandateIds", [BigInt(i)])) as Hex;
    const [textHash, rulesHash, expiry, status, pools, tokens] = (await v("getMandate", [id])) as [Hex, Hex, bigint, number, Address[], Address[]];
    if (Number(status) !== 1 || expiry < now) continue;
    const limits: ActiveMandate["limits"] = {};
    for (const t of tokens) {
      const [perTradeCap, dailyCap, softLimit, spentToday, dayIndex] = (await v("limits", [id, t])) as bigint[];
      limits[t.toLowerCase()] = { perTradeCap: perTradeCap!, dailyCap: dailyCap!, softLimit: softLimit!, spentToday: spentToday!, dayIndex: dayIndex! };
    }
    // The strategy template lives in the signed rules. Only act on a mandate file whose hashes match the chain.
    const f = join(REPO_ROOT, "mandates", `${id}.json`);
    if (!existsSync(f)) { log({ event: "skip", mandateId: id, reason: "no local mandate file; cannot verify its rules" }); continue; }
    const mf = JSON.parse(readFileSync(f, "utf8"));
    if (keccak256(toHex(mf.rulesJson)) !== rulesHash || keccak256(toHex(mf.text)) !== textHash) {
      log({ event: "skip", mandateId: id, reason: "local mandate file does not match on-chain textHash/rulesHash" });
      continue;
    }
    return { id, expiry, pools, tokens, limits, template: mf.draft.template, schedule: mf.draft.schedule ?? null, text: mf.text };
  }
  return null;
}

// ------------------------------------------------------------------ strategy

interface Decision { action: "trade" | "hold"; why: string; tokenIn?: Address; tokenOut?: Address; amountIn?: bigint; minOut?: bigint; quote?: bigint; needsGuardian?: boolean; facts: Record<string, string> }

async function decide(m: ActiveMandate): Promise<Decision> {
  const pool = m.pools.find((p) => p.toLowerCase() === POOL.toLowerCase());
  if (!pool) return { action: "hold", why: "mandate does not allow the known pool", facts: {} };
  const [a, b] = [TOK.QTA!, TOK.QTB!];
  const [balA, balB] = await Promise.all([a, b].map((t) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [VAULT] }) as Promise<bigint>));
  const priceAinB = (await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "quote", args: [a, b, ONE] })) as bigint; // B per 1 A (after fee)
  const valueA = (balA! * priceAinB) / ONE; // in B units
  const total = valueA + balB!;
  const target = total / 2n;
  const facts = { balanceQTA: formatUnits(balA!, 18), balanceQTB: formatUnits(balB!, 18), priceQTAinQTB: formatUnits(priceAinB, 18), shareQTA: `${Number((valueA * 10000n) / (total || 1n)) / 100}%` };

  const driftBps = total === 0n ? 0n : ((valueA > target ? valueA - target : target - valueA) * 10000n) / total;
  const dca = m.template === "dca";
  if (!dca && driftBps < DRIFT_BPS) return { action: "hold", why: `portfolio within ${Number(DRIFT_BPS) / 100}% of 50/50 (drift ${Number(driftBps) / 100}%)`, facts };

  // DCA: always buy QTB with QTA in fixed chunks; rebalance/swap: sell whichever side is overweight
  const sellA = dca ? true : valueA > target;
  const tokenIn = sellA ? a : b;
  const tokenOut = sellA ? b : a;
  // amount of tokenIn needed to get back to 50/50 (approx: half the excess)
  let need = dca ? 2n ** 255n : sellA ? ((valueA - target) * ONE) / (priceAinB || 1n) : target - valueA;
  if (!dca && need === 0n) need = 1n;
  const L = m.limits[tokenIn.toLowerCase()];
  if (!L) return { action: "hold", why: `mandate does not allow ${SYM(tokenIn)}`, facts };
  const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
  const spent = L.dayIndex === today ? L.spentToday : 0n;
  const dailyLeft = L.dailyCap > spent ? L.dailyCap - spent : 0n;
  const caps = { perTrade: L.perTradeCap, dailyLeft, soft: L.softLimit };
  // stay at or under the soft limit so no guardian is needed (Phase 3 adds the guardian ladder)
  let amountIn = [need, caps.perTrade, caps.dailyLeft, caps.soft].reduce((x, y) => (y < x ? y : x));
  if (amountIn === 0n) return { action: "hold", why: `daily cap for ${SYM(tokenIn)} used up (${formatUnits(spent, 18)} of ${formatUnits(L.dailyCap, 18)})`, facts };
  const quote = (await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: "quote", args: [tokenIn, tokenOut, amountIn] })) as bigint;
  const minOut = (quote * 99n) / 100n; // 1% slippage
  return {
    action: "trade", tokenIn, tokenOut, amountIn, minOut, quote, needsGuardian: amountIn > L.softLimit,
    why: dca ? `dca (${m.schedule ?? "each step"}): buy QTB with ${formatUnits(amountIn, 18)} QTA (capped by per-trade ${formatUnits(caps.perTrade, 18)}, daily left ${formatUnits(caps.dailyLeft, 18)}, soft limit ${formatUnits(caps.soft, 18)})` : `rebalance: ${SYM(tokenIn)} is overweight (drift ${Number(driftBps) / 100}%); sell ${formatUnits(amountIn, 18)} ${SYM(tokenIn)} (needed ${formatUnits(need, 18)}, capped by per-trade ${formatUnits(caps.perTrade, 18)}, daily left ${formatUnits(caps.dailyLeft, 18)}, soft limit ${formatUnits(caps.soft, 18)})`,
    facts,
  };
}

// ------------------------------------------------------------------ LLM narration (optional)

async function narrate(d: Decision, mandateId: Hex): Promise<string | undefined> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return undefined;
  try {
    const client = new Anthropic();
    const r = await client.beta.messages.create({
      model: process.env.AGENT_LLM_MODEL || "claude-opus-5-5",
      max_tokens: 1000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: "You are the voice of a treasury agent. In two short sentences, explain the decision below to the owner. Do not suggest different amounts; the decision is final and was made by a deterministic strategy inside a signed mandate.",
      messages: [{ role: "user", content: JSON.stringify({ mandateId, decision: { ...d, amountIn: d.amountIn?.toString(), minOut: d.minOut?.toString(), quote: d.quote?.toString() } }) }],
    });
    if (r.stop_reason === "refusal") return undefined;
    return r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ").trim();
  } catch {
    return undefined; // narration is cosmetic; never block or alter a decision
  }
}

// ------------------------------------------------------------------ execute

async function step() {
  const safe = await safetyCheck();
  if (!safe.ok) { log({ event: "stopped", reason: safe.reason }); return "stop" as const; }
  const m = await activeMandate();
  if (!m) { log({ event: "idle", reason: "no active, unexpired mandate" }); return "idle" as const; }
  const d = await decide(m);
  const reasoning = await narrate(d, m.id);
  if (d.action === "hold") { log({ event: "hold", mandateId: m.id, why: d.why, facts: d.facts, reasoning }); return "hold" as const; }

  const entry = { mandateId: m.id, pool: POOL, tokenIn: SYM(d.tokenIn!), tokenOut: SYM(d.tokenOut!), amountIn: d.amountIn, minOut: d.minOut, quote: d.quote, guardianUsed: false, why: d.why, facts: d.facts, reasoning };
  if (DRY) { log({ event: "decision (dry run)", ...entry }); return "dry" as const; }

  // re-check right before submitting
  const again = await safetyCheck();
  if (!again.ok) { log({ event: "stopped", reason: again.reason, mandateId: m.id }); return "stop" as const; }

  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "trade", args: [
    { mandateId: m.id, pool: POOL, tokenIn: d.tokenIn!, tokenOut: d.tokenOut!, amountIn: d.amountIn!, minOut: d.minOut! },
    { pubkey: "0x", signature: "0x", nonce: 0n, expiry: 0n },
  ] });
  // EVM logs emitted inside MsgExecuteEVM are not exposed via eth_getLogs (docs/SPIKES.md), so the trade is
  // verified from state: the vault's output balance and the mandate's spentToday counter must both move.
  const outBefore = (await pub.readContract({ address: d.tokenOut!, abi: ERC20, functionName: "balanceOf", args: [VAULT] })) as bigint;
  const spentBefore = ((await v("limits", [m.id, d.tokenIn!])) as bigint[])[3]!;
  try {
    const r = await agentExecuteEvm({ relayer: loadAccount("relayer"), smartAccount: loadAccount("agentacct").cosmos, agent: loadOrCreateLinkKey("agent"), to: VAULT, data, gasLimit: 400_000n });
    const outAfter = (await pub.readContract({ address: d.tokenOut!, abi: ERC20, functionName: "balanceOf", args: [VAULT] })) as bigint;
    const spentAfter = ((await v("limits", [m.id, d.tokenIn!])) as bigint[])[3]!;
    if (outAfter < outBefore + d.minOut!) throw new Error("vault did not receive at least minOut");
    const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
    if (spentAfter !== spentBefore + d.amountIn! && spentAfter !== d.amountIn!) throw new Error(`spentToday moved ${spentBefore}→${spentAfter}, expected +${d.amountIn} (day ${today})`);
    log({ event: "trade", ...entry, txHash: r.transactionHash, height: r.height, authNonce: r.authNonce, amountOut: outAfter - outBefore, spentToday: spentAfter });
    return "traded" as const;
  } catch (e: any) {
    log({ event: "trade failed", ...entry, error: e instanceof TxFailed ? e.message : String(e.message ?? e) });
    return "failed" as const;
  }
}

async function main() {
  console.log(`agent | ${DEPLOYMENT} vault ${VAULT} | ${ONCE ? "one step" : `every ${INTERVAL}s`}${DRY ? " | dry run" : ""}`);
  for (;;) {
    const r = await step();
    if (ONCE || r === "stop") break;
    await new Promise((res) => setTimeout(res, INTERVAL * 1000));
  }
}

await main();
