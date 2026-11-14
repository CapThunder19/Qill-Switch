import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeAbiParameters, keccak256, toHex } from "viem";
import { keygen, sign, verify, encodeMessage, actionId, pubkeyHash, writeKeyFile, readKeyFile,
  MLDSA87_PUBKEY_BYTES, MLDSA87_SIG_BYTES } from "../src/index.js";
import vectors from "./vectors.json" with { type: "json" };

describe("ML-DSA-87", () => {
  const kp = keygen();
  it("has QoreChain sizes", () => {
    expect(kp.publicKey.length).toBe(MLDSA87_PUBKEY_BYTES);
    expect(sign("0x01", kp.secretKey).length).toBe(MLDSA87_SIG_BYTES);
  });
  it("verifies and rejects tampering", () => {
    const sig = sign("0xdeadbeef", kp.secretKey);
    expect(verify(sig, "0xdeadbeef", kp.publicKey)).toBe(true);
    expect(verify(sig, "0xdeadbeee", kp.publicKey)).toBe(false);
    const bad = sig.slice(); bad[0] ^= 1;
    expect(verify(bad, "0xdeadbeef", kp.publicKey)).toBe(false);
    expect(verify(sig, "0xdeadbeef", keygen().publicKey)).toBe(false);
  });
  it("is deterministic from seed", () => {
    const s = new Uint8Array(32).fill(1);
    expect(keygen(s).publicKey).toEqual(keygen(s).publicKey);
  });
  it("rejects bad seed length", () => expect(() => keygen(new Uint8Array(31))).toThrow());
});

describe("canonical message", () => {
  it("action ids are keccak of name", () => {
    expect(actionId("Q_DAY")).toBe(keccak256(toHex("Q_DAY")));
  });
  it("matches the abi layout", () => {
    const m = encodeMessage({ chainId: 9800n, verifyingContract: "0x00000000000000000000000000000000000000aa",
      action: "RESUME", params: "0x1234", nonce: 5n, expiry: 99n });
    const [domain, chainId, addr, action, ph, nonce, expiry] = decodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }], m);
    expect(domain).toBe("QILLSWITCH_V1");
    expect(chainId).toBe(9800n);
    expect(addr.toLowerCase()).toBe("0x00000000000000000000000000000000000000aa");
    expect(action).toBe(actionId("RESUME"));
    expect(ph).toBe(keccak256("0x1234"));
    expect(nonce).toBe(5n);
    expect(expiry).toBe(99n);
  });
  it("binds every field", () => {
    const base = { chainId: 9800n, verifyingContract: "0x00000000000000000000000000000000000000aa" as const,
      action: "PAUSE" as const, params: "0x" as const, nonce: 0n, expiry: 1n };
    const m = encodeMessage(base);
    for (const v of [{ chainId: 1n }, { verifyingContract: "0x00000000000000000000000000000000000000bb" as const },
      { action: "RESUME" as const }, { params: "0x00" as const }, { nonce: 1n }, { expiry: 2n }])
      expect(encodeMessage({ ...base, ...v })).not.toBe(m);
  });
  it("matches stored cross-language vectors", () => {
    const pk = keygen(new Uint8Array(32).fill(7)).publicKey;
    expect(pubkeyHash(pk)).toBe(vectors.publicKeyHash);
    for (const v of vectors.vectors) {
      const m = encodeMessage({ chainId: BigInt(vectors.chainId), verifyingContract: vectors.verifyingContract as `0x${string}`,
        action: v.action as any, params: v.params as `0x${string}`, nonce: BigInt(v.nonce), expiry: BigInt(v.expiry) });
      expect(m).toBe(v.message);
      expect(verify(Buffer.from(v.signature.slice(2), "hex"), m, pk)).toBe(true);
    }
  });
});

describe("key files", () => {
  it("round-trips outside the repo and refuses inside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "qill-"));
    const repo = resolve(__dirname, "../../..");
    try {
      const kp = keygen();
      const f = join(dir, "owner.json");
      writeKeyFile(f, kp, { repoRoot: repo });
      expect(readKeyFile(f, { repoRoot: repo }).publicKey).toEqual(kp.publicKey);
      expect(() => writeKeyFile(f, kp)).toThrow(/exists/);
      expect(() => writeKeyFile(join(repo, "x.json"), kp, { repoRoot: repo })).toThrow(/inside the repo/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
