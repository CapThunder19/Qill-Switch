/**
 * Guardian policy: pure and deterministic. Facts are gathered from chain by the guardian itself; nothing the agent
 * claims is trusted. Returns every reason to deny. The guardian can only veto: an LLM review may add a denial,
 * never remove one.
 */
export interface GuardianFacts {
  now: number;
  mandate: { status: number; expiry: bigint; pools: string[]; tokens: string[] };
  limits: { perTradeCap: bigint; dailyCap: bigint; softLimit: bigint; spentToday: bigint; dayIndex: bigint };
  trade: { pool: string; tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint };
  /** pool quote for exactly amountIn right now */
  quote: bigint;
  /** spot output for amountIn at current reserves, before price impact and fees */
  spotOut: bigint;
  /** unix seconds of this guardian's previous approvals for this mandate */
  recentApprovals: number[];
}

export const POLICY = {
  minMandateTtlSec: 60,
  maxSlippageBps: 200n, // minOut must be >= 98% of the live quote
  maxPriceImpactBps: 300n, // quote must be >= 97% of spot
  maxApprovalsPerHour: 3,
  minSecondsBetweenApprovals: 30,
} as const;

export function evaluate(f: GuardianFacts): { approve: boolean; reasons: string[] } {
  const r: string[] = [];
  const lc = (s: string) => s.toLowerCase();
  const { trade: t, limits: L, mandate: m } = f;

  if (m.status !== 1) r.push("mandate is not active");
  if (m.expiry < BigInt(f.now + POLICY.minMandateTtlSec)) r.push("mandate expired or about to expire");
  if (!m.pools.map(lc).includes(lc(t.pool))) r.push("pool not in mandate");
  if (!m.tokens.map(lc).includes(lc(t.tokenIn)) || !m.tokens.map(lc).includes(lc(t.tokenOut))) r.push("token not in mandate");
  if (lc(t.tokenIn) === lc(t.tokenOut)) r.push("tokenIn == tokenOut");

  if (t.amountIn <= L.softLimit) r.push("guardian not required at or below the soft limit");
  if (t.amountIn > L.perTradeCap) r.push("above per-trade cap");
  const today = BigInt(Math.floor(f.now / 86400));
  const spent = L.dayIndex === today ? L.spentToday : 0n;
  if (spent + t.amountIn > L.dailyCap) r.push("would exceed daily cap");

  if (f.quote === 0n) r.push("pool returns no output");
  else {
    if (t.minOut * 10000n < f.quote * (10000n - POLICY.maxSlippageBps)) r.push(`minOut below ${Number(10000n - POLICY.maxSlippageBps) / 100}% of live quote`);
    if (f.quote > t.minOut * 2n && t.minOut === 0n) r.push("minOut is zero");
  }
  if (f.spotOut > 0n && f.quote * 10000n < f.spotOut * (10000n - POLICY.maxPriceImpactBps)) r.push(`price impact above ${Number(POLICY.maxPriceImpactBps) / 100}%`);

  const lastHour = f.recentApprovals.filter((ts) => ts > f.now - 3600);
  if (lastHour.length >= POLICY.maxApprovalsPerHour) r.push(`already ${lastHour.length} guardian approvals for this mandate in the last hour`);
  const last = Math.max(0, ...f.recentApprovals);
  if (f.now - last < POLICY.minSecondsBetweenApprovals) r.push("approvals too frequent");

  return { approve: r.length === 0, reasons: r };
}
