import { z } from "zod";

/**
 * A mandate DRAFT: what the owner asked for, in human units. Produced either by the deterministic template
 * parser or by the LLM, then checked by the deterministic validator. Amounts are decimal strings in token
 * units (e.g. "100" = 100 QTA), never floats.
 */
export const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "decimal string, e.g. \"100\" or \"12.5\"");

export const TEMPLATES = ["swap", "dca", "rebalance"] as const;

export const MandateDraftSchema = z.object({
  template: z.enum(TEMPLATES).describe("swap = free trading within limits; dca = buy one token on a schedule; rebalance = keep a ratio"),
  tokens: z.array(z.string()).describe("token symbols the agent may trade, e.g. [\"QTA\", \"QTB\"]"),
  pools: z.array(z.string()).describe("pool names the agent may use, e.g. [\"demo-pool\"]"),
  perTradeCap: DecimalString.describe("max amount of the input token per trade, in token units"),
  dailyCap: DecimalString.describe("max total input per UTC day per token, in token units"),
  softLimit: DecimalString.describe("trades above this amount need the guardian co-signature"),
  expiryDays: z.number().int().describe("how many days the mandate lasts"),
  schedule: z.string().nullable().describe("optional cadence such as \"every 4h\"; null if none"),
});
export type MandateDraft = z.infer<typeof MandateDraftSchema>;

/** Known tokens and pools (addresses), from a deployment record. */
export interface Universe {
  vault: `0x${string}`;
  tokens: Record<string, { address: `0x${string}`; decimals: number }>;
  pools: Record<string, { address: `0x${string}`; tokens: string[] }>;
}

/** Global ceilings the validator enforces regardless of what the text says. */
export const GLOBAL_LIMITS = {
  maxExpiryDays: 30,
  maxPerTrade: "1000",
  maxDaily: "5000",
  /**
   * Native QOR the smart account may move per authorised execution / per day (uqor). Agent trades move none.
   * Kept at the minimum non-zero value: a rule-bound linked key may still send plain VALUE without an
   * allowed_evm_calls entry, so these limits are the only bound on that path (0 would mean "no limit").
   */
  aaPerTxUqor: 1n,
  aaDailyUqor: 1n,
} as const;
