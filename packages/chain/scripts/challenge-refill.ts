/**
 * "Steal This Agent" monitor + refill. Safe to run any time (or on a schedule).
 *  1. checks integrity against the baseline in apps/challenge/public/challenge.json:
 *     landed txs from the published key (account nonce), vault/pool token balances, vault control, smart account balance
 *  2. tops the bait back up to TARGET (default 3 QOR) from the funder, and the vault's ownerNonce is reported
 *  3. appends the result to logs/challenge.jsonl
 *   tsx scripts/challenge-refill.ts [targetQor]
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Address } from "viem";
import { REPO_ROOT, loadAccount } from "../src/accounts.js";
import { bankSend, getBalance, evmWindow } from "../src/cosmos.js";
import { publicClient as pub, VAULT_ABI } from "../src/vault.js";

const TARGET = BigInt(Math.round(Number(process.argv[2] ?? 3) * 1e6));
const cfg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/challenge/public/challenge.json"), "utf8"));
const C = cfg.contracts as Record<string, Address>;
const B = cfg.baseline;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (t: Address, w: Address) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [w] }) as Promise<bigint>;
const v = (fn: string) => pub.readContract({ address: C.QillVault!, abi: VAULT_ABI, functionName: fn });

const challenge = loadAccount("challenge");
const nonce = await pub.getTransactionCount({ address: challenge.evm as Address });
const [vA, vB, pA, pB] = await Promise.all([bal(C.TokenA!, C.QillVault!), bal(C.TokenB!, C.QillVault!), bal(C.TokenA!, C.MockPool!), bal(C.TokenB!, C.MockPool!)]);
const [paused, frozen, executor, ownerNonce] = await Promise.all(["paused", "qDayFrozen", "executor", "ownerNonce"].map(v));
const smartUqor = await getBalance(cfg.smartAccount.cosmos);
const windows = { challenge: (await evmWindow(challenge.cosmos)).live, smart: (await evmWindow(cfg.smartAccount.cosmos)).live };

const findings: string[] = [];
if (nonce !== B.challengeAccountNonce) findings.push(`published key landed ${nonce - B.challengeAccountNonce} tx(s)`);
if (vA + pA < BigInt(B.vaultQTA) + BigInt(B.poolQTA)) findings.push("Token A left the vault+pool system");
if (vB + pB < BigInt(B.vaultQTB) + BigInt(B.poolQTB)) findings.push("Token B left the vault+pool system");
if (vA < BigInt(B.vaultQTA) || vB < BigInt(B.vaultQTB)) findings.push("vault token balance below baseline");
if (frozen || Number(ownerNonce) !== B.ownerNonce || (executor as string).toLowerCase() !== cfg.smartAccount.evm.toLowerCase()) findings.push("vault control changed");
if (smartUqor > 0n) findings.push(`smart account holds ${smartUqor} uqor (should be 0)`);
if (windows.challenge || windows.smart) findings.push("an EVM window is open on a challenge account");

const before = await getBalance(challenge.cosmos);
let refill: string | undefined;
if (before < TARGET) refill = (await bankSend(loadAccount("funder"), challenge.cosmos, TARGET - before)).transactionHash;
const entry = { ts: new Date().toISOString(), intact: findings.length === 0, findings, baitUqorBefore: before.toString(), refillTx: refill,
  nonce, vault: { A: vA.toString(), B: vB.toString(), paused, frozen, ownerNonce: Number(ownerNonce) }, smartUqor: smartUqor.toString(), windows };
mkdirSync(join(REPO_ROOT, "logs"), { recursive: true });
appendFileSync(join(REPO_ROOT, "logs", "challenge.jsonl"), JSON.stringify(entry) + "\n");
console.log(JSON.stringify(entry, null, 2));
process.exitCode = findings.length ? 1 : 0;
