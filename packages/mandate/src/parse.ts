import type { MandateDraft, Universe } from "./schema.js";

/**
 * Deterministic template parser: plain English → MandateDraft, with no model involved.
 * Understands phrasings like:
 *   "Trade QTA and QTB on demo-pool. Max 100 per trade, 250 per day, guardian above 40, for 7 days."
 *   "DCA into QTB from QTA every 4h on demo-pool, at most 20 per trade and 100 per day, 14 days, guardian over 15"
 * Anything it cannot find is left out, so the validator rejects the draft instead of guessing.
 */
export function parseMandateText(text: string, universe: Universe): Partial<MandateDraft> {
  const t = text.toLowerCase();
  const num = String.raw`(\d+(?:\.\d+)?)`;
  const pick = (...res: RegExp[]) => {
    for (const re of res) {
      const m = t.match(re);
      if (m) return m[1];
    }
    return undefined;
  };

  const tokens = Object.keys(universe.tokens).filter((s) => new RegExp(`\\b${s.toLowerCase()}\\b`).test(t));
  const pools = Object.keys(universe.pools).filter((p) => t.includes(p.toLowerCase()));

  const template: MandateDraft["template"] = /\bdca\b|dollar[- ]cost/.test(t) ? "dca" : /rebalanc/.test(t) ? "rebalance" : "swap";

  const perTradeCap = pick(
    new RegExp(`(?:max(?:imum)?|at most|up to|no more than)\\s+${num}\\s*(?:\\w+\\s+)?(?:per|a|each)\\s+(?:trade|swap)`),
    new RegExp(`${num}\\s*(?:\\w+\\s+)?per\\s+(?:trade|swap)`),
  );
  const dailyCap = pick(
    new RegExp(`${num}\\s*(?:\\w+\\s+)?(?:per|a|each)\\s+day`),
    new RegExp(`${num}\\s*(?:\\w+\\s+)?daily`),
    new RegExp(`daily\\s+(?:cap|limit|max(?:imum)?)\\s+(?:of\\s+)?${num}`),
  );
  const softLimit = pick(
    new RegExp(`guardian\\s+(?:above|over|for anything above|beyond)\\s+${num}`),
    new RegExp(`(?:above|over)\\s+${num}\\s*(?:\\w+\\s+)?(?:needs|requires|need)\\s+(?:the\\s+)?guardian`),
  );
  const days = pick(new RegExp(`(?:for\\s+)?${num}\\s+days?`), /(?:for\s+)?(\d+)\s+weeks?/);
  const weeks = /(\d+)\s+weeks?/.test(t) && !/(\d+)\s+days?/.test(t);
  const schedule = t.match(/every\s+\d+\s*(?:m|min|minutes?|h|hours?|d|days?)\b/)?.[0] ?? null;

  const draft: Partial<MandateDraft> = { template, tokens, pools, schedule };
  if (perTradeCap) draft.perTradeCap = perTradeCap;
  if (dailyCap) draft.dailyCap = dailyCap;
  if (softLimit) draft.softLimit = softLimit;
  if (days) draft.expiryDays = weeks ? Number(days) * 7 : Number(days);
  return draft;
}
