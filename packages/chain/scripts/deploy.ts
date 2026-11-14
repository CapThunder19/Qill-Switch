/**
 * Deploy the Phase 1 (drill) set to qorechain-diana from the drill account:
 *   MockERC20 A, MockERC20 B, MockPool(A,B), QillVault(owner, guardian, executor=0, [A,B], [pool])
 * then seed pool liquidity and the vault, so the drill account itself ends with ZERO tokens.
 *
 * Window policy: ONE unscoped window (scoped windows refuse contract creation), maxTxs = exactly the
 * number of txs below, maxValue = their summed max fees + 10%, short block count. Closed and verified
 * closed at the end, even on failure.
 *
 *   pnpm --filter @qill/chain exec tsx scripts/deploy.ts            # dry run: estimate only
 *   pnpm --filter @qill/chain exec tsx scripts/deploy.ts --execute  # deploy
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, http, defineChain, encodeDeployData, encodeFunctionData,
  type Abi, type Hex, type Address, zeroAddress, getContractAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmWindowCost } from "@qorechain/evm/window";
import { readKeyFile, pubkeyHash } from "@qill/pq";
import { loadAccount, keyDir, REPO_ROOT } from "../src/accounts.js";
import { NET, openWindow, closeWindow, evmWindow, getBalance } from "../src/cosmos.js";

const EXECUTE = process.argv.includes("--execute");
const ONE = 10n ** 18n;
const LIQ = 100_000n * ONE; // per token, locked forever in the pool
const VAULT_SEED = 10_000n * ONE; // per token, held by the vault
const SUPPLY = LIQ + VAULT_SEED; // nothing left on the drill EOA

const qore = defineChain({ id: NET.evmChainId, name: NET.chainId, nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evmRpc] } } });
const pub = createPublicClient({ chain: qore, transport: http() });

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/artifacts/src", path), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode };
}
const ERC20 = artifact("mocks/MockERC20.sol/MockERC20.json");
const POOL = artifact("mocks/MockPool.sol/MockPool.json");
const VAULT = artifact("QillVault.sol/QillVault.json");

async function main() {
  const drill = loadAccount("drill");
  const eoa = privateKeyToAccount(drill.privateKey as Hex);
  if (eoa.address.toLowerCase() !== drill.evm.toLowerCase()) throw new Error("key/address mismatch");
  const wallet = createWalletClient({ account: eoa, chain: qore, transport: http() });

  const ownerHash = pubkeyHash(readKeyFile(join(keyDir(), "owner.mldsa.json"), { repoRoot: REPO_ROOT }).publicKey);
  const guardianHash = pubkeyHash(readKeyFile(join(keyDir(), "guardian.mldsa.json"), { repoRoot: REPO_ROOT }).publicKey);

  // ---- plan every tx up front (addresses predicted from the nonce the window will leave us at)
  const nonce0Now = BigInt(await pub.getTransactionCount({ address: eoa.address, blockTag: "pending" }));
  const n0 = nonce0Now + 1n; // opening the window (a Cosmos-lane tx) advances the nonce by one
  const tokA = getContractAddress({ from: eoa.address, nonce: n0 });
  const tokB = getContractAddress({ from: eoa.address, nonce: n0 + 1n });
  const pool = getContractAddress({ from: eoa.address, nonce: n0 + 2n });
  const vault = getContractAddress({ from: eoa.address, nonce: n0 + 3n });

  const erc20 = (fn: string, args: unknown[]) => encodeFunctionData({ abi: ERC20.abi, functionName: fn, args });
  const plan: { label: string; to?: Address; data: Hex; gas: bigint }[] = [
    { label: "deploy Token A", data: encodeDeployData({ ...ERC20, args: ["Qill Test A", "QTA", eoa.address, SUPPLY] }), gas: 0n },
    { label: "deploy Token B", data: encodeDeployData({ ...ERC20, args: ["Qill Test B", "QTB", eoa.address, SUPPLY] }), gas: 0n },
    { label: "deploy MockPool", data: encodeDeployData({ ...POOL, args: [tokA, tokB] }), gas: 0n },
    { label: "deploy QillVault", data: encodeDeployData({ ...VAULT, args: [ownerHash, guardianHash, zeroAddress, [tokA, tokB], [pool]] }), gas: 0n },
    { label: "A.approve(pool)", to: tokA, data: erc20("approve", [pool, LIQ]), gas: 80_000n },
    { label: "B.approve(pool)", to: tokB, data: erc20("approve", [pool, LIQ]), gas: 80_000n },
    { label: "pool.addLiquidity", to: pool, data: encodeFunctionData({ abi: POOL.abi, functionName: "addLiquidity", args: [LIQ, LIQ] }), gas: 220_000n },
    { label: "A.transfer(vault)", to: tokA, data: erc20("transfer", [vault, VAULT_SEED]), gas: 80_000n },
    { label: "B.transfer(vault)", to: tokB, data: erc20("transfer", [vault, VAULT_SEED]), gas: 80_000n },
  ];
  for (const p of plan.slice(0, 4)) {
    const est = await pub.estimateGas({ account: eoa.address, data: p.data });
    p.gas = (est * 13n) / 10n;
  }
  const gasPrice = await pub.getGasPrice();
  const maxPriorityFeePerGas = await pub.estimateMaxPriorityFeePerGas();
  const maxFeePerGas = (gasPrice * 3n) / 2n;
  const costUqor = plan.reduce((s, p) => s + evmWindowCost({ gas: p.gas, maxFeePerGas }), 0n);
  const maxValue = (costUqor * 11n) / 10n + 1n;

  console.log("deployer", eoa.address, "balance", Number(await getBalance(drill.cosmos)) / 1e6, "QOR");
  console.log("gasPrice", gasPrice, "maxFee", maxFeePerGas, "window maxValue", maxValue, "uqor =", Number(maxValue) / 1e6, "QOR");
  for (const p of plan) console.log(`  ${p.label.padEnd(20)} gas ${p.gas}`);
  console.log("predicted:", { tokA, tokB, pool, vault });
  if (!EXECUTE) { console.log("\ndry run only; pass --execute to deploy"); return; }

  const w0 = await evmWindow(drill.cosmos);
  if (w0.found && w0.live) throw new Error("drill already has a live window; close it first");

  const hashes: Record<string, Hex> = {};
  try {
    const open = await openWindow(drill, { blocks: 400, maxTxs: plan.length, maxValue, allowContractCreation: true });
    console.log("window opened", open.transactionHash);
    let nonce = BigInt(await pub.getTransactionCount({ address: eoa.address, blockTag: "pending" }));
    if (nonce !== n0) throw new Error(`nonce after window is ${nonce}, expected ${n0}; addresses would differ`);
    for (const p of plan) {
      const h = await wallet.sendTransaction({ to: p.to ?? null, data: p.data, gas: p.gas, maxFeePerGas, maxPriorityFeePerGas, nonce: Number(nonce), value: 0n } as any);
      const r = await pub.waitForTransactionReceipt({ hash: h });
      console.log(`  ${p.label.padEnd(20)} ${r.status} ${h}${r.contractAddress ? " -> " + r.contractAddress : ""}`);
      if (r.status !== "success") throw new Error(`${p.label} reverted`);
      hashes[p.label] = h;
      nonce++;
    }
  } finally {
    const c = await closeWindow(drill);
    const w = await evmWindow(drill.cosmos);
    console.log("window closed", c.txHash ?? "(already gone)", "live now:", w.live);
  }

  // ---- verify
  const read = (fn: string, args: unknown[] = []) => pub.readContract({ address: vault, abi: VAULT.abi, functionName: fn, args });
  const bal = (t: Address, who: Address) => pub.readContract({ address: t, abi: ERC20.abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  const checks = {
    ownerKeyHash: (await read("ownerKeyHash")) === ownerHash,
    guardianKeyHash: (await read("guardianKeyHash")) === guardianHash,
    executorIsZero: (await read("executor")) === zeroAddress,
    tokenAAllowed: await read("tokenAllowed", [tokA]),
    tokenBAllowed: await read("tokenAllowed", [tokB]),
    poolAllowed: await read("poolAllowed", [pool]),
    vaultA: (await bal(tokA, vault)) === VAULT_SEED,
    vaultB: (await bal(tokB, vault)) === VAULT_SEED,
    drillHoldsNoA: (await bal(tokA, eoa.address)) === 0n,
    drillHoldsNoB: (await bal(tokB, eoa.address)) === 0n,
  };
  console.log("checks", checks);
  if (Object.values(checks).some((v) => v !== true)) throw new Error("post-deploy check failed");

  const out = { network: NET.chainId, evmChainId: NET.evmChainId, deployer: eoa.address, deployedAt: new Date().toISOString(),
    contracts: { QillVault: vault, MockPool: pool, TokenA: tokA, TokenB: tokB }, ownerKeyHash: ownerHash, guardianKeyHash: guardianHash, txs: hashes };
  mkdirSync(join(REPO_ROOT, "deployments"), { recursive: true });
  writeFileSync(join(REPO_ROOT, "deployments", `${NET.chainId}.json`), JSON.stringify(out, null, 2));
  console.log("wrote deployments/" + NET.chainId + ".json");
}

await main();
