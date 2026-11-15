import { describe, it, expect } from "vitest";
import { evaluate, type GuardianFacts } from "../src/policy.js";

const E = 10n ** 18n;
const NOW = 1_800_000_000;
const base = (): GuardianFacts => ({
  now: NOW,
  mandate: { status: 1, expiry: BigInt(NOW + 86400), pools: ["0xPOOL"], tokens: ["0xA", "0xB"] },
  limits: { perTradeCap: 50n * E, dailyCap: 150n * E, softLimit: 20n * E, spentToday: 0n, dayIndex: BigInt(Math.floor(NOW / 86400)) },
  trade: { pool: "0xpool", tokenIn: "0xa", tokenOut: "0xb", amountIn: 30n * E, minOut: 29n * E },
  quote: 29_500n * E / 1000n, spotOut: 30n * E, recentApprovals: [],
});
const deny = (f: GuardianFacts, re: RegExp) => {
  const r = evaluate(f);
  expect(r.approve).toBe(false);
  expect(r.reasons.join("; ")).toMatch(re);
};

describe("guardian policy", () => {
  it("approves an in-mandate trade above the soft limit", () => expect(evaluate(base())).toEqual({ approve: true, reasons: [] }));
  it("is not needed at or below the soft limit", () => { const f = base(); f.trade.amountIn = 20n * E; deny(f, /not required/); });
  it("vetoes above the per-trade cap", () => { const f = base(); f.trade.amountIn = 51n * E; deny(f, /per-trade cap/); });
  it("vetoes past the daily cap", () => { const f = base(); f.limits.spentToday = 130n * E; deny(f, /daily cap/); });
  it("ignores yesterday's spend", () => { const f = base(); f.limits.spentToday = 140n * E; f.limits.dayIndex -= 1n; expect(evaluate(f).approve).toBe(true); });
  it("vetoes revoked or expiring mandates", () => {
    const f = base(); f.mandate.status = 2; deny(f, /not active/);
    const g = base(); g.mandate.expiry = BigInt(NOW + 10); deny(g, /expire/);
  });
  it("vetoes wrong pool and tokens", () => {
    const f = base(); f.trade.pool = "0xother"; deny(f, /pool not in mandate/);
    const g = base(); g.trade.tokenOut = "0xc"; deny(g, /token not in mandate/);
  });
  it("vetoes loose slippage", () => { const f = base(); f.trade.minOut = 28n * E; deny(f, /minOut below 98%/); });
  it("vetoes high price impact", () => { const f = base(); f.quote = 28n * E; f.trade.minOut = 28n * E; deny(f, /price impact/); });
  it("vetoes when the pool returns nothing", () => { const f = base(); f.quote = 0n; deny(f, /no output/); });
  it("rate-limits approvals", () => {
    const f = base(); f.recentApprovals = [NOW - 3000, NOW - 2000, NOW - 1000]; deny(f, /3 guardian approvals/);
    const g = base(); g.recentApprovals = [NOW - 5]; deny(g, /too frequent/);
  });
});
