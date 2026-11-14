/**
 * Phase 1 bootstrap. Safe to re-run: every step checks chain state first.
 *
 *  1. funder (holds faucet QOR) registers its ML-DSA-87 key.
 *  2. funder sends the drill account ONLY the registration fee (DRILL_BOOT_UQOR).
 *  3. drill registers its ML-DSA-87 key (classical bootstrap tx, with proof of possession)
 *     while holding nothing but that fee.
 *  4. verify registration (REST + pqcKeyStatus precompile: registered && possessionProven).
 *  5. only then funder tops the drill account up to DRILL_TARGET_UQOR.
 *  6. confirm neither account has an open EVM window.
 */
import { createPublicClient, http, defineChain, bytesToHex } from "viem";
import { loadAccount } from "../src/accounts.js";
import { bankSend, closeWindow, evmWindow, getAccountInfo, getBalance, pqcStatus, registerPqcKey, NET } from "../src/cosmos.js";

const DRILL_BOOT_UQOR = BigInt(process.env.DRILL_BOOT_UQOR ?? "150000"); // 0.15 QOR: fee for the registration tx only
const DRILL_TARGET_UQOR = BigInt(process.env.DRILL_TARGET_UQOR ?? "20000000"); // 20 QOR for deployment + drill proof

const qore = defineChain({ id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evmRpc] } } });
const evm = createPublicClient({ chain: qore, transport: http() });
const keyStatusAbi = [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }] as const;

async function precompileStatus(addr: `0x${string}`) {
  const [registered, alg, pubkey, pop] = await evm.readContract({ address: "0x0000000000000000000000000000000000000a02", abi: keyStatusAbi, functionName: "pqcKeyStatus", args: [addr] });
  return { registered, alg, pubkey, pop };
}

async function ensureRegistered(name: string) {
  const acct = loadAccount(name);
  const r = await registerPqcKey(acct);
  console.log(`[${name}] register:`, r.alreadyRegistered ? "already registered" : `tx ${r.txHash}`);
  const rest = await pqcStatus(acct.cosmos);
  const pre = await precompileStatus(acct.evm as `0x${string}`);
  const matches = rest.publicKey === bytesToHex(acct.pqc.publicKey) && pre.pubkey === bytesToHex(acct.pqc.publicKey);
  console.log(`[${name}] verify: rest.registered=${rest.registered} precompile.registered=${pre.registered} alg=${pre.alg} possessionProven=${pre.pop} keyMatches=${matches}`);
  if (!rest.registered || !pre.registered || pre.alg !== 1 || !matches) throw new Error(`${name}: registration not confirmed`);
  if (!pre.pop) console.warn(`[${name}] WARNING: possessionProven=false`);
  return acct;
}

async function main() {
  const funder = loadAccount("funder");
  const drill = loadAccount("drill");

  const fb = await getBalance(funder.cosmos);
  console.log(`[funder] ${funder.cosmos} balance ${Number(fb) / 1e6} QOR`);
  if (!(await getAccountInfo(funder.cosmos)) || fb === 0n) {
    console.log(`\nfunder has no QOR. Claim faucet funds to ${funder.cosmos} at https://dashboard.qorechain.io/faucet, then re-run.`);
      process.exitCode = 2;
      return;
  }

  // 1
  await ensureRegistered("funder");

  // 2 + 3
  const drillStatus = await pqcStatus(drill.cosmos);
  if (!drillStatus.registered) {
    const db = await getBalance(drill.cosmos);
    if (db > DRILL_BOOT_UQOR * 2n) throw new Error(`drill unexpectedly holds ${db} uqor before registration; stop and investigate`);
    if (db < DRILL_BOOT_UQOR) {
      const s = await bankSend(funder, drill.cosmos, DRILL_BOOT_UQOR - db);
      console.log(`[funder→drill] boot fee ${DRILL_BOOT_UQOR - db} uqor tx ${s.transactionHash}`);
    }
  }
  // 4
  await ensureRegistered("drill");

  // 5
  const db = await getBalance(drill.cosmos);
  if (db < DRILL_TARGET_UQOR) {
    const s = await bankSend(funder, drill.cosmos, DRILL_TARGET_UQOR - db);
    console.log(`[funder→drill] top-up ${DRILL_TARGET_UQOR - db} uqor tx ${s.transactionHash}`);
  }

  // 6
  for (const a of [funder, drill]) {
    const w = await evmWindow(a.cosmos);
    if (w.found && w.live) await closeWindow(a);
    console.log(`[${a === funder ? "funder" : "drill"}] window live=${(await evmWindow(a.cosmos)).live}  balance=${Number(await getBalance(a.cosmos)) / 1e6} QOR`);
  }
  console.log("\nbootstrap complete");
}

await main();
