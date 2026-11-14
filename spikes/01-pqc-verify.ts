/**
 * Spike 1: does @noble/post-quantum ml_dsa87 (FIPS 204, empty context) verify with
 * QoreChain's pqcVerify precompile (0x...0A01) on testnet? Read-only (eth_call), no funds needed.
 * Run: pnpm --filter @qill/pq exec tsx ../../spikes/01-pqc-verify.ts
 */
import { createPublicClient, http, keccak256, bytesToHex, defineChain } from "viem";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { keygen, sign, encodeMessage } from "@qill/pq";

const qore = defineChain({
  id: 9800,
  name: "qorechain-diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host"] } },
});
const client = createPublicClient({ chain: qore, transport: http() });
const PQC = "0x0000000000000000000000000000000000000a01" as const;
const KEYSTATUS = "0x0000000000000000000000000000000000000a02" as const;
const abi = [
  { type: "function", name: "pqcVerify", stateMutability: "view",
    inputs: [{ name: "pubkey", type: "bytes" }, { name: "signature", type: "bytes" }, { name: "message", type: "bytes" }],
    outputs: [{ name: "valid", type: "bool" }] },
  { type: "function", name: "pqcKeyStatus", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "registered", type: "bool" }, { name: "algorithmId", type: "uint8" }, { name: "pubkey", type: "bytes" }, { name: "possessionProven", type: "bool" }] },
] as const;

async function check(label: string, pk: Uint8Array, sig: Uint8Array, msg: Uint8Array | `0x${string}`) {
  try {
    const ok = await client.readContract({ address: PQC, abi, functionName: "pqcVerify",
      args: [bytesToHex(pk), bytesToHex(sig), typeof msg === "string" ? msg : bytesToHex(msg)] });
    console.log(`${label.padEnd(44)} -> ${ok}`);
    return ok;
  } catch (e: any) {
    console.log(`${label.padEnd(44)} -> ERROR ${e.shortMessage ?? e.message}`);
    return undefined;
  }
}

const chainId = await client.getChainId();
const block = await client.getBlock();
const prev = await client.getBlock({ blockNumber: block.number - 100n });
console.log("chainId", chainId, "block", block.number, "avg block time (s, last 100)",
  Number(block.timestamp - prev.timestamp) / 100);

const k = keygen();
const msg = encodeMessage({ chainId: 9800n, verifyingContract: "0x00000000000000000000000000000000000000aa",
  action: "PAUSE", params: "0x", nonce: 0n, expiry: 2n ** 40n });
const sig = sign(msg, k.secretKey);

await check("noble FIPS204 empty ctx (expected true)", k.publicKey, sig, msg);
const bad = sig.slice(); bad[10] ^= 1;
await check("tampered signature (expected false)", k.publicKey, bad, msg);
await check("wrong message (expected false)", k.publicKey, sig, keccak256(msg));
const k2 = keygen();
await check("wrong pubkey (expected false)", k2.publicKey, sig, msg);
await check("signed keccak(msg), passed keccak(msg)", k.publicKey, sign(keccak256(msg), k.secretKey), keccak256(msg));
const ctxSig = ml_dsa87.sign(Buffer.from(msg.slice(2), "hex"), k.secretKey, { context: new TextEncoder().encode("qorechain") });
await check("context='qorechain' (diagnostic)", k.publicKey, ctxSig, msg);

// gas estimate for a typical verify
const gas = await client.estimateContractGas({ address: PQC, abi, functionName: "pqcVerify",
  args: [bytesToHex(k.publicKey), bytesToHex(sig), msg], account: "0x00000000000000000000000000000000000000aa" }).catch((e) => `ERR ${e.shortMessage}`);
console.log("estimateGas pqcVerify", gas);

const ks = await client.readContract({ address: KEYSTATUS, abi, functionName: "pqcKeyStatus",
  args: ["0x00000000000000000000000000000000000000aa"] }).catch((e) => `ERR ${e.shortMessage}`);
console.log("pqcKeyStatus(random addr)", ks);
