import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";

export const MLDSA87_PUBKEY_BYTES = 2592;
export const MLDSA87_SIG_BYTES = 4627;

export interface MlDsaKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** 32-byte seed the pair was derived from (what we persist). */
  seed: Uint8Array;
}

export function keygen(seed: Uint8Array = randomBytes(32)): MlDsaKeypair {
  if (seed.length !== 32) throw new Error("ML-DSA-87 seed must be 32 bytes");
  const { publicKey, secretKey } = ml_dsa87.keygen(seed);
  return { publicKey, secretKey, seed };
}

/** FIPS 204 pure ML-DSA-87, empty context, hedged randomness. */
export function sign(message: Uint8Array | Hex, secretKey: Uint8Array): Uint8Array {
  const msg = typeof message === "string" ? hexToBytes(message) : message;
  return ml_dsa87.sign(msg, secretKey);
}

export function verify(signature: Uint8Array, message: Uint8Array | Hex, publicKey: Uint8Array): boolean {
  const msg = typeof message === "string" ? hexToBytes(message) : message;
  return ml_dsa87.verify(signature, msg, publicKey);
}

/** keccak256(pubkey): what QillVault stores as ownerKeyHash / guardianKeyHash. */
export function pubkeyHash(publicKey: Uint8Array): Hex {
  return keccak256(publicKey);
}

export { bytesToHex, hexToBytes };
