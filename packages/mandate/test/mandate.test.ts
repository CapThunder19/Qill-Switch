import { describe, it, expect } from "vitest";
import { keccak256, toHex, parseUnits, encodeAbiParameters } from "viem";
import { MANDATE_PARAMS_TYPE, TRADE_SELECTOR } from "@qill/chain";
import {
  parseMandateText, validateDraft, compileFromText, compileDraft, compileWithLlm, verifyCompiled, canonicalJson,
  MandateRejected, type Universe, type MandateDraft,
} from "../src/index.js";

const U: Universe = {
  vault: "0x00000000000000000000000000000000000000aa",
  tokens: { QTA: { address: "0x00000000000000000000000000000000000000a1", decimals: 18 }, QTB: { address: "0x00000000000000000000000000000000000000b1", decimals: 18 } },
  pools: { "demo-pool": { address: "0x00000000000000000000000000000000000000c1", tokens: ["QTA", "QTB"] } },
};
const TEXT = "Trade QTA and QTB on demo-pool. Max 100 per trade, 250 per day, guardian above 40, for 7 days.";
const GOOD: MandateDraft = { template: "swap", tokens: ["QTA", "QTB"], pools: ["demo-pool"], perTradeCap: "100", dailyCap: "250", softLimit: "40", expiryDays: 7, schedule: null };

describe("template parser", () => {
  it("extracts every field from plain English", () => {
    expect(parseMandateText(TEXT, U)).toEqual(GOOD);
  });
  it("handles DCA phrasing, weeks and schedules", () => {
    const d = parseMandateText("DCA into QTB from QTA every 4h on demo-pool, at most 20 per trade and 100 per day, for 2 weeks, guardian over 15", U);
    expect(d).toMatchObject({ template: "dca", perTradeCap: "20", dailyCap: "100", softLimit: "15", expiryDays: 14, schedule: "every 4h" });
  });
  it("leaves out what it cannot find (no guessing)", () => {
    const d = parseMandateText("Trade QTA and QTB on demo-pool however you like", U);
    expect(d.perTradeCap).toBeUndefined();
    expect(d.dailyCap).toBeUndefined();
    expect(() => validateDraft(d, U)).toThrow(MandateRejected);
  });
});

describe("validator", () => {
  const bad = (patch: Partial<MandateDraft>, re: RegExp) => expect(() => validateDraft({ ...GOOD, ...patch }, U)).toThrow(re);
  it("accepts a good draft", () => expect(validateDraft(GOOD, U)).toEqual(GOOD));
  it("rejects missing limits", () => {
    const { dailyCap, ...rest } = GOOD;
    expect(() => validateDraft(rest, U)).toThrow(/dailyCap/);
  });
  it("rejects zero limits", () => bad({ perTradeCap: "0" }, /perTradeCap: must be > 0/));
  it("rejects expiry > 30 days", () => bad({ expiryDays: 31 }, /expiryDays: 31 > 30/));
  it("rejects unknown pools and tokens", () => {
    bad({ pools: ["uniswap"] }, /unknown pool/);
    bad({ tokens: ["QTA", "WETH"] }, /unknown token/);
  });
  it("rejects empty allowlists", () => {
    bad({ pools: [] }, /empty pool allowlist/);
    bad({ tokens: [] }, /at least two/);
  });
  it("rejects caps above the global ceiling", () => {
    bad({ perTradeCap: "1001", dailyCap: "2000" }, /global ceiling 1000/);
    bad({ dailyCap: "5001" }, /global ceiling 5000/);
  });
  it("rejects ordering violations", () => {
    bad({ softLimit: "101" }, /softLimit/);
    bad({ perTradeCap: "300" }, /perTradeCap: must be <= dailyCap/);
  });
  it("rejects pools whose tokens are not all allowed", () => {
    const U2: Universe = { ...U, tokens: { ...U.tokens, QTC: { address: "0x00000000000000000000000000000000000000d1", decimals: 18 } } };
    expect(() => validateDraft({ ...GOOD, tokens: ["QTA", "QTC"] }, U2)).toThrow(/trades QTA\/QTB, not all allowed/);
  });
  it("rejects malformed amounts (floats, negatives, words)", () => {
    bad({ perTradeCap: "-5" }, /decimal string/);
    bad({ perTradeCap: "lots" }, /decimal string/);
  });
});

describe("compiler", () => {
  const c = compileFromText(TEXT, U, { now: 1_800_000_000 });
  it("produces vault params in base units with the right expiry", () => {
    expect(c.vaultParams.perTradeCap).toEqual([parseUnits("100", 18), parseUnits("100", 18)]);
    expect(c.vaultParams.dailyCap).toEqual([parseUnits("250", 18), parseUnits("250", 18)]);
    expect(c.vaultParams.softLimit).toEqual([parseUnits("40", 18), parseUnits("40", 18)]);
    expect(c.vaultParams.expiry).toBe(1_800_000_000n + 7n * 86400n);
    expect(c.vaultParams.pools).toEqual([U.pools["demo-pool"]!.address]);
  });
  it("smart-account rule: enabled, bounded, vault.trade only", () => {
    expect(c.aaRules).toHaveLength(1);
    const r = c.aaRules[0]!;
    expect(r.enabled).toBe(true);
    expect(BigInt(r.perTxLimit!)).toBeGreaterThan(0n);
    expect(BigInt(r.dailyLimit!)).toBeGreaterThan(0n);
    expect(r.allowedEvmCalls).toEqual([`${U.vault}/${TRADE_SELECTOR}`]);
    expect(c.allowedEvmCalls).toEqual([`${U.vault}/${TRADE_SELECTOR}`]);
  });
  it("hashes commit to text and canonical rules; id commits to both", () => {
    expect(c.textHash).toBe(keccak256(toHex(TEXT)));
    expect(c.rulesHash).toBe(keccak256(toHex(c.rulesJson)));
    expect(c.vaultParams.id).toBe(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [c.textHash, c.rulesHash])));
    verifyCompiled(c);
    expect(() => verifyCompiled({ ...c, text: TEXT + " and anything else" })).toThrow(/textHash/);
  });
  it("is deterministic", () => {
    expect(compileFromText(TEXT, U, { now: 1_800_000_000 })).toEqual(c);
  });
  it("canonical JSON sorts keys and stringifies bigints", () => {
    expect(canonicalJson({ b: 2n, a: [1n, { d: 1, c: 2 }] })).toBe('{"a":["1",{"c":2,"d":1}],"b":"2"}');
  });
  it("vault params ABI-encode as the vault's MandateParams tuple", () => {
    expect(() => encodeAbiParameters([MANDATE_PARAMS_TYPE], [c.vaultParams])).not.toThrow();
  });
});

describe("LLM path goes through the same validator", () => {
  // Gemini: the model returns JSON text, validated by @qill/llm and then by the mandate validator
  const gem = (draft: unknown) => ({ provider: "gemini" as const, clients: { gemini: { models: { generateContent: async () => ({ text: draft === undefined ? undefined : JSON.stringify(draft) }) } } } });
  // Claude: structured-output parse
  const claude = (draft: unknown, stop_reason = "end_turn") => ({ provider: "anthropic" as const, clients: { anthropic: { beta: { messages: {
    create: async () => ({}),
    parse: async (req: any) => {
      expect(req.model).toBe("claude-opus-5-5");
      expect(req.fallbacks).toBe("default");
      return { parsed_output: draft, stop_reason, stop_details: stop_reason === "refusal" ? { explanation: "no" } : null };
    },
  } } } } });

  for (const [name, via] of [["gemini", gem], ["claude", claude]] as const) {
    it(`${name}: accepts a good draft`, async () => {
      const c = await compileWithLlm(TEXT, U, { ...via(GOOD), now: 1_800_000_000 });
      expect(c.source).toBe("llm");
      expect(c.vaultParams.perTradeCap[0]).toBe(parseUnits("100", 18));
    });
    it(`${name}: rejects inflated caps, invented pools, stretched expiry`, async () => {
      await expect(compileWithLlm(TEXT, U, via({ ...GOOD, perTradeCap: "100000", dailyCap: "100000" }))).rejects.toThrow(/global ceiling/);
      await expect(compileWithLlm(TEXT, U, via({ ...GOOD, pools: ["router"] }))).rejects.toThrow(/unknown pool/);
      await expect(compileWithLlm(TEXT, U, via({ ...GOOD, expiryDays: 90 }))).rejects.toThrow(/expiryDays/);
    });
  }
  it("surfaces refusals, off-schema and empty output", async () => {
    await expect(compileWithLlm(TEXT, U, claude(null, "refusal"))).rejects.toThrow(/declined/);
    await expect(compileWithLlm(TEXT, U, claude(null))).rejects.toThrow(/no parsable draft/);
    await expect(compileWithLlm(TEXT, U, gem({ ...GOOD, perTradeCap: 100 }))).rejects.toThrow(/no parsable draft/);
    await expect(compileWithLlm(TEXT, U, gem(undefined))).rejects.toThrow(/no parsable draft/);
  });
});

it("compileDraft marks the source", () => {
  expect(compileDraft(TEXT, GOOD, U).source).toBe("template");
});
