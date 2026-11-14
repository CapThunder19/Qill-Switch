import { encodeAbiParameters, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { agentRule, TRADE_SELECTOR, type MandateParams } from "@qill/chain";
import type { SpendingRuleInput } from "@qorechain/sdk";
import { GLOBAL_LIMITS, type MandateDraft, type Universe } from "./schema.js";
import { validateDraft } from "./validate.js";
import { parseMandateText } from "./parse.js";

export interface CompiledMandate {
  text: string;
  draft: MandateDraft;
  /** Smart-account spending rule (the account's FULL rule set: exactly this one rule). */
  aaRules: SpendingRuleInput[];
  allowedEvmCalls: string[];
  /** Exactly what the owner signs into QillVault.createMandate. */
  vaultParams: MandateParams;
  textHash: Hex;
  rulesHash: Hex;
  /** Canonical JSON the rulesHash commits to (show this next to the text). */
  rulesJson: string;
  source: "template" | "llm";
}

/** JSON with sorted keys and bigints as decimal strings: the byte-exact preimage of rulesHash. */
export function canonicalJson(v: unknown): string {
  const norm = (x: any): any => {
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])]));
    return x;
  };
  return JSON.stringify(norm(v));
}

export function compileDraft(text: string, input: Partial<MandateDraft>, universe: Universe,
  opts: { now?: number; source?: "template" | "llm" } = {}): CompiledMandate {
  const draft = validateDraft(input, universe);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiry = BigInt(now + draft.expiryDays * 86400);

  const tokens = draft.tokens.map((s) => universe.tokens[s]!);
  const pools = draft.pools.map((p) => universe.pools[p]!.address);
  const amounts = (v: string) => tokens.map((t) => parseUnits(v, t.decimals));

  const aaRule = agentRule({ vault: universe.vault, perTxLimitUqor: GLOBAL_LIMITS.aaPerTxUqor, dailyLimitUqor: GLOBAL_LIMITS.aaDailyUqor });
  // Never produce a disabled or unbounded rule, and never allow any call but vault.trade.
  if (aaRule.enabled !== true) throw new Error("internal: rule must be enabled");
  const allowedEvmCalls = [`${universe.vault.toLowerCase()}/${TRADE_SELECTOR}`];
  if (JSON.stringify(aaRule.allowedEvmCalls) !== JSON.stringify(allowedEvmCalls)) throw new Error("internal: allowed_evm_calls drift");

  const rulesBody = {
    version: 1,
    vault: universe.vault.toLowerCase(),
    template: draft.template,
    schedule: draft.schedule,
    expiry,
    pools: pools.map((p) => p.toLowerCase()),
    tokens: tokens.map((t) => t.address.toLowerCase()),
    perTradeCap: amounts(draft.perTradeCap),
    dailyCap: amounts(draft.dailyCap),
    softLimit: amounts(draft.softLimit),
    smartAccountRules: [aaRule],
  };
  const rulesJson = canonicalJson(rulesBody);
  const textHash = keccak256(toHex(text));
  const rulesHash = keccak256(toHex(rulesJson));
  const id = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [textHash, rulesHash]));

  const vaultParams: MandateParams = {
    id, textHash, rulesHash, expiry,
    pools: pools as Address[],
    tokens: tokens.map((t) => t.address) as Address[],
    perTradeCap: amounts(draft.perTradeCap),
    dailyCap: amounts(draft.dailyCap),
    softLimit: amounts(draft.softLimit),
  };
  return { text, draft, aaRules: [aaRule], allowedEvmCalls, vaultParams, textHash, rulesHash, rulesJson, source: opts.source ?? "template" };
}

/** Deterministic path: template parser → validator → compiled mandate. No model involved. */
export function compileFromText(text: string, universe: Universe, opts: { now?: number } = {}): CompiledMandate {
  return compileDraft(text, parseMandateText(text, universe), universe, { ...opts, source: "template" });
}

/** Recompute the hashes from a compiled mandate and check they match (use before signing). */
export function verifyCompiled(c: CompiledMandate): void {
  if (keccak256(toHex(c.text)) !== c.textHash) throw new Error("textHash does not match text");
  if (keccak256(toHex(c.rulesJson)) !== c.rulesHash) throw new Error("rulesHash does not match rulesJson");
  if (c.vaultParams.textHash !== c.textHash || c.vaultParams.rulesHash !== c.rulesHash) throw new Error("vault params hashes differ");
}
