import { parseUnits } from "viem";
import { GLOBAL_LIMITS, MandateDraftSchema, type MandateDraft, type Universe } from "./schema.js";

export class MandateRejected extends Error {
  constructor(readonly problems: string[]) {
    super(`mandate rejected:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Deterministic validator. The ONLY gate between any draft (template parser or LLM) and a signable mandate.
 * Rejects: missing limits, zero limits, expiry > 30 days, unknown pools/tokens, caps above the global ceiling,
 * empty allowlists, soft > per-trade > daily ordering violations, pools that don't connect the listed tokens.
 */
export function validateDraft(input: Partial<MandateDraft>, universe: Universe): MandateDraft {
  const problems: string[] = [];
  const parsed = MandateDraftSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) problems.push(`${i.path.join(".") || "draft"}: ${i.message}`);
    throw new MandateRejected(problems);
  }
  const d = parsed.data;

  if (d.tokens.length < 2) problems.push("tokens: need at least two allowed tokens (empty or single-token allowlist)");
  if (d.pools.length === 0) problems.push("pools: empty pool allowlist");
  if (new Set(d.tokens).size !== d.tokens.length) problems.push("tokens: duplicates");
  if (new Set(d.pools).size !== d.pools.length) problems.push("pools: duplicates");
  for (const s of d.tokens) if (!universe.tokens[s]) problems.push(`tokens: unknown token "${s}"`);
  for (const p of d.pools) {
    const pool = universe.pools[p];
    if (!pool) problems.push(`pools: unknown pool "${p}"`);
    else if (!pool.tokens.every((s) => d.tokens.includes(s))) problems.push(`pools: "${p}" trades ${pool.tokens.join("/")}, not all allowed`);
  }

  if (d.expiryDays < 1) problems.push("expiryDays: must be at least 1");
  if (d.expiryDays > GLOBAL_LIMITS.maxExpiryDays) problems.push(`expiryDays: ${d.expiryDays} > ${GLOBAL_LIMITS.maxExpiryDays}`);

  const amt = (v: string) => parseUnits(v, 18);
  const per = amt(d.perTradeCap), daily = amt(d.dailyCap), soft = amt(d.softLimit);
  if (per === 0n) problems.push("perTradeCap: must be > 0");
  if (daily === 0n) problems.push("dailyCap: must be > 0");
  if (soft > per) problems.push("softLimit: must be <= perTradeCap");
  if (per > daily) problems.push("perTradeCap: must be <= dailyCap");
  if (per > amt(GLOBAL_LIMITS.maxPerTrade)) problems.push(`perTradeCap: above global ceiling ${GLOBAL_LIMITS.maxPerTrade}`);
  if (daily > amt(GLOBAL_LIMITS.maxDaily)) problems.push(`dailyCap: above global ceiling ${GLOBAL_LIMITS.maxDaily}`);

  if (problems.length) throw new MandateRejected(problems);
  return d;
}
