import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { bytesToHex, hexToBytes } from "viem";
import { keygen, type MlDsaKeypair } from "./mldsa.js";

/**
 * Key file = JSON { alg, seed, publicKey }. Only the 32-byte seed is secret.
 * Files are refused if they would land inside the repository.
 */
export interface KeyFile {
  alg: "ML-DSA-87";
  seed: `0x${string}`;
  publicKey: `0x${string}`;
}

function assertOutsideRepo(path: string, repoRoot?: string) {
  if (!repoRoot) return;
  const p = resolve(path).toLowerCase();
  const r = resolve(repoRoot).toLowerCase() + sep;
  if (p.startsWith(r)) throw new Error(`refusing to touch key file inside the repo: ${path}`);
}

export function writeKeyFile(path: string, kp: MlDsaKeypair, opts: { repoRoot?: string; overwrite?: boolean } = {}) {
  assertOutsideRepo(path, opts.repoRoot);
  if (existsSync(path) && !opts.overwrite) throw new Error(`key file exists: ${path}`);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const data: KeyFile = { alg: "ML-DSA-87", seed: bytesToHex(kp.seed), publicKey: bytesToHex(kp.publicKey) };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function readKeyFile(path: string, opts: { repoRoot?: string } = {}): MlDsaKeypair {
  assertOutsideRepo(path, opts.repoRoot);
  const data = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  if (data.alg !== "ML-DSA-87") throw new Error(`unsupported key alg ${data.alg}`);
  const kp = keygen(hexToBytes(data.seed));
  if (bytesToHex(kp.publicKey) !== data.publicKey.toLowerCase()) throw new Error("key file public key mismatch");
  return kp;
}
