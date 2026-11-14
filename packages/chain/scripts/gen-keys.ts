/**
 * Generate every key Phase 1 needs, outside the repo (QILL_KEY_DIR, default ~/.qill/keys).
 * Idempotent: existing keys are never overwritten.
 *
 *   funder   chain account; receives faucet QOR, pays fees for the others
 *   drill    chain account for the Q-Day Drill (its ECDSA key is handed to the drill bot)
 *   owner    ML-DSA-87 key that signs QillVault commands (not a chain account)
 *   guardian ML-DSA-87 key that co-signs large trades (not a chain account)
 *
 * Prints public info only.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { keygen, pubkeyHash, writeKeyFile, readKeyFile } from "@qill/pq";
import { accountAddresses, accountExists, generateAccount, keyDir, loadAccount, REPO_ROOT } from "../src/accounts.js";
import { keccak256 } from "viem";

const out: Record<string, unknown> = { keyDir: keyDir() };

for (const name of ["funder", "drill"]) {
  const created = !accountExists(name);
  const acct = created ? generateAccount(name) : loadAccount(name);
  out[name] = { created, ...accountAddresses(name), pqcPublicKeyHash: keccak256(acct.pqc.publicKey) };
}

for (const name of ["owner", "guardian"]) {
  const f = join(keyDir(), `${name}.mldsa.json`);
  const created = !existsSync(f);
  if (created) writeKeyFile(f, keygen(), { repoRoot: REPO_ROOT });
  const kp = readKeyFile(f, { repoRoot: REPO_ROOT });
  out[name] = { created, mldsaPublicKeyHash: pubkeyHash(kp.publicKey) };
}

console.log(JSON.stringify(out, null, 2));
