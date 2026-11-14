import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";
import { bytesToHex, hexToBytes, keccak256 } from "viem";

/**
 * Account key material lives OUTSIDE the repo, in QILL_KEY_DIR (default ~/.qill/keys).
 *
 * Each chain account (eth_secp256k1, coin type 60) is split into two files:
 *   <name>.ecdsa.json       classical secp256k1 key (for the drill account this is the key we hand over)
 *   <name>.pqc-secret.json  independent 32-byte secret the account's ML-DSA-87 key is derived from
 * The PQC key is derived via the SDK's `unifiedAccountFromSeed(seed, { pqcSecret })`, so knowing the
 * ECDSA key reveals nothing about the ML-DSA key.
 */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export function keyDir(): string {
  const dir = resolve(process.env.QILL_KEY_DIR ?? join(homedir(), ".qill", "keys"));
  if ((dir + sep).toLowerCase().startsWith((REPO_ROOT + sep).toLowerCase()))
    throw new Error(`QILL_KEY_DIR must be outside the repo (${dir})`);
  return dir;
}

interface EcdsaFile {
  kind: "qorechain-eth-secp256k1";
  privateKey: `0x${string}`;
  publicKey: string;
  evm: string;
  cosmos: string;
}
interface PqcSecretFile {
  kind: "qorechain-pqc-secret";
  pqcSecret: `0x${string}`;
  pqcPublicKeyHash: `0x${string}`;
}

const ecdsaPath = (name: string) => join(keyDir(), `${name}.ecdsa.json`);
const pqcPath = (name: string) => join(keyDir(), `${name}.pqc-secret.json`);

export function accountExists(name: string): boolean {
  return existsSync(ecdsaPath(name)) || existsSync(pqcPath(name));
}

export function generateAccount(name: string): UnifiedAccount {
  if (accountExists(name)) throw new Error(`account "${name}" already exists in ${keyDir()}`);
  mkdirSync(keyDir(), { recursive: true });
  const seed = new Uint8Array(randomBytes(32));
  const pqcSecret = new Uint8Array(randomBytes(32));
  const acct = unifiedAccountFromSeed(seed, { pqcSecret });
  const e: EcdsaFile = {
    kind: "qorechain-eth-secp256k1",
    privateKey: acct.privateKey as `0x${string}`,
    publicKey: acct.publicKey,
    evm: acct.evm,
    cosmos: acct.cosmos,
  };
  const p: PqcSecretFile = {
    kind: "qorechain-pqc-secret",
    pqcSecret: bytesToHex(pqcSecret),
    pqcPublicKeyHash: keccak256(acct.pqc.publicKey),
  };
  writeFileSync(ecdsaPath(name), JSON.stringify(e, null, 2), { mode: 0o600, flag: "wx" });
  writeFileSync(pqcPath(name), JSON.stringify(p, null, 2), { mode: 0o600, flag: "wx" });
  return acct;
}

/** Load the full account (classical + PQC). */
export function loadAccount(name: string): UnifiedAccount {
  const e = JSON.parse(readFileSync(ecdsaPath(name), "utf8")) as EcdsaFile;
  const p = JSON.parse(readFileSync(pqcPath(name), "utf8")) as PqcSecretFile;
  const acct = unifiedAccountFromSeed(hexToBytes(e.privateKey), { pqcSecret: hexToBytes(p.pqcSecret) });
  if (acct.evm !== e.evm) throw new Error(`${name}: ECDSA key file does not match its address`);
  if (keccak256(acct.pqc.publicKey) !== p.pqcPublicKeyHash) throw new Error(`${name}: PQC secret does not match`);
  return acct;
}

/** Load only the public addresses (no secrets parsed into memory beyond the file read). */
export function accountAddresses(name: string): { evm: string; cosmos: string } {
  const e = JSON.parse(readFileSync(ecdsaPath(name), "utf8")) as EcdsaFile;
  return { evm: e.evm, cosmos: e.cosmos };
}
