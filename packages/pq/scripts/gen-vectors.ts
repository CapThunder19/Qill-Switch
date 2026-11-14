/**
 * Writes cross-language test vectors for the canonical message encoding (consumed by Foundry).
 * Keys here are derived from fixed PUBLIC test seeds — never use them for anything real.
 */
import { writeFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, bytesToHex } from "viem";
import { encodeMessage, actionId, keygen, sign, pubkeyHash, type ActionName } from "../src/index.js";

const seed = new Uint8Array(32).fill(7);
const kp = keygen(seed);
const contract = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as const; // first `new` in a forge test (deployer = test contract)

const cases: { action: ActionName; params: `0x${string}`; nonce: bigint; expiry: bigint }[] = [
  { action: "PAUSE", params: "0x", nonce: 0n, expiry: 1_800_000_000n },
  { action: "WITHDRAW", params: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }],
      ["0x000000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000000000", 10n ** 18n]),
    nonce: 3n, expiry: 1_800_000_123n },
];
const vectors = cases.map((c) => {
  const message = encodeMessage({ chainId: 9800n, verifyingContract: contract, ...c });
  return { action: c.action, actionId: actionId(c.action), params: c.params, nonce: c.nonce.toString(),
    expiry: c.expiry.toString(), message, messageHash: keccak256(message),
    signature: bytesToHex(sign(message, kp.secretKey)) };
});
const out = { chainId: 9800, verifyingContract: contract, testSeed: bytesToHex(seed),
  publicKey: bytesToHex(kp.publicKey), publicKeyHash: pubkeyHash(kp.publicKey), vectors };
writeFileSync(new URL("../../../contracts/test/vectors/message.json", import.meta.url), JSON.stringify(out, null, 2));
writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote", vectors.length, "vectors");
