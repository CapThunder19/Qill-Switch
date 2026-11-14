/**
 * Spikes 3 + 4: smart account + rules + linked agent key, and MsgExecuteEVM into the vault.
 * Idempotent and staged. Never touches the drill account or the drill vault.
 *
 *   tsx scripts/spike-aa.ts            # run every step that is not done yet
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, toHex, parseAbi, type Address, type Hex } from "viem";
import { REPO_ROOT, accountExists, generateAccount, loadAccount } from "../src/accounts.js";
import { bankSend, getAccountInfo, getBalance, pqcStatus, registerPqcKey, evmWindow, TxFailed } from "../src/cosmos.js";
import { publicClient as pub, VAULT_ABI, relayToVault, signOwnerCommand, type MandateParams } from "../src/vault.js";
import { agentExecuteEvm, agentRule, linkAgentKey, loadOrCreateLinkKey, readAuthenticators, readRules, TRADE_SELECTOR } from "../src/aa.js";

const ONE = 10n ** 18n;
const BOOT = 150_000n;
const log = (...a: unknown[]) => console.log(...a);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function fundAndRegister(name: string, targetUqor: bigint) {
  const funder = loadAccount("funder");
  if (!accountExists(name)) { generateAccount(name); log(`[${name}] generated`); }
  const a = loadAccount(name);
  const st = await pqcStatus(a.cosmos);
  if (!st.registered) {
    const bal = await getBalance(a.cosmos);
    if (bal < BOOT) await bankSend(funder, a.cosmos, BOOT - bal);
    const r = await registerPqcKey(a);
    log(`[${name}] PQC registered`, r);
  }
  const bal = await getBalance(a.cosmos);
  if (bal < targetUqor) await bankSend(funder, a.cosmos, targetUqor - bal);
  log(`[${name}] ${a.cosmos} / ${a.evm} balance ${Number(await getBalance(a.cosmos)) / 1e6} QOR, pqc registered`);
  return a;
}

async function main() {
  // 1-2 accounts
  const relayer = await fundAndRegister("relayer", 15_000_000n);
  const smart = await fundAndRegister("agentacct", 1_000_000n);
  const agent = loadOrCreateLinkKey("agent");
  log(`[agent] link key ${agent.address}${agent.created ? " (new)" : ""}`);

  // 3 demo deployment (executor = smart account's EVM address)
  const demoFile = join(REPO_ROOT, "deployments", "demo.json");
  if (!existsSync(demoFile)) {
    log("deploying demo set ...");
    const out = execFileSync(process.execPath, [
      "--import", "tsx", join(REPO_ROOT, "packages/chain/scripts/deploy.ts"),
      "--deployer", "relayer", "--executor", smart.evm, "--name", "demo", "--execute",
    ], { cwd: join(REPO_ROOT, "packages/chain"), encoding: "utf8" });
    log(out.split("\n").filter((l) => /success|checks|wrote|window/.test(l)).join("\n"));
  }
  const demo = JSON.parse(readFileSync(demoFile, "utf8"));
  const vault = demo.contracts.QillVault as Address;
  const pool = demo.contracts.MockPool as Address;
  const tokA = demo.contracts.TokenA as Address;
  const tokB = demo.contracts.TokenB as Address;
  const read = (fn: string, args: unknown[] = []) => pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args });
  log(`[demo] vault ${vault} executor ${await read("executor")} paused ${await read("paused")}`);

  // 4 mandate
  const MID = keccak256(toHex("demo-mandate-1"));
  const m = (await read("getMandate", [MID])) as any[];
  if (Number(m[3]) === 0) {
    const text = "Trade Token A <-> Token B on the demo pool. Max 100 per trade, 250 per day; above 40 needs the guardian. 7 days.";
    const p: MandateParams = {
      id: MID, textHash: keccak256(toHex(text)), rulesHash: keccak256(toHex("spike-rules")),
      expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 86400), pools: [pool], tokens: [tokA, tokB],
      perTradeCap: [100n * ONE, 100n * ONE], dailyCap: [250n * ONE, 250n * ONE], softLimit: [40n * ONE, 40n * ONE],
    };
    const { data } = await signOwnerCommand(vault, "createMandate", [p]);
    const r = await relayToVault(vault, data, "relayer");
    log(`[mandate] created ${MID} tx ${r.hash} gas ${r.gasUsed}`);
  } else log(`[mandate] exists, status ${m[3]}`);

  // 5 link agent key + rules
  const auths = await readAuthenticators(smart.cosmos);
  const linked = (auths as any[]).some((a) => String(a.pubkey ?? a.publicKey ?? "").toLowerCase().includes(agent.address.slice(2).toLowerCase()) && !a.revoked);
  if (!linked) {
    const r = await linkAgentKey(smart, agent, agentRule({ vault, perTxLimitUqor: 1_000n, dailyLimitUqor: 10_000n }));
    log(`[link] tx ${r.txHash}`);
  }
  log("[rules]", JSON.stringify(await readRules(smart.cosmos), big));
  log("[authenticators]", JSON.stringify(await readAuthenticators(smart.cosmos), big));
  log(`[smart] window ${JSON.stringify(await evmWindow(smart.cosmos), big)}`);

  // 6 in-mandate trade via MsgExecuteEVM
  const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const bal = async () => [await pub.readContract({ address: tokA, abi: ERC20, functionName: "balanceOf", args: [vault] }),
    await pub.readContract({ address: tokB, abi: ERC20, functionName: "balanceOf", args: [vault] })];
  const quote = (await pub.readContract({ address: pool, abi: parseAbi(["function quote(address,address,uint256) view returns (uint256)"]),
    functionName: "quote", args: [tokA, tokB, 10n * ONE] })) as bigint;
  const noG = { pubkey: "0x" as Hex, signature: "0x" as Hex, nonce: 0n, expiry: 0n };
  const tradeData = (amountIn: bigint, minOut: bigint) => encodeFunctionData({ abi: VAULT_ABI, functionName: "trade",
    args: [{ mandateId: MID, pool, tokenIn: tokA, tokenOut: tokB, amountIn, minOut }, noG] });

  const before = await bal();
  try {
    const r = await agentExecuteEvm({ relayer, smartAccount: smart.cosmos, agent, to: vault, data: tradeData(10n * ONE, (quote * 98n) / 100n), gasLimit: 400_000n });
    const after = await bal();
    log(`[trade ok] tx ${r.transactionHash} authNonce ${r.authNonce} digest ${r.digestVersion} | vault A ${before[0]}→${after[0]} B ${before[1]}→${after[1]}`);
  } catch (e: any) {
    log(`[trade FAILED] ${e.message}`);
  }

  // 7 negatives: each must fail
  const neg = async (label: string, to: Address, data: Hex) => {
    try {
      const r = await agentExecuteEvm({ relayer, smartAccount: smart.cosmos, agent, to, data, gasLimit: 400_000n });
      log(`!! [${label}] UNEXPECTED SUCCESS ${r.transactionHash}`);
    } catch (e: any) {
      log(`ok [${label}] rejected: ${(e instanceof TxFailed ? "" : "") + String(e.message).slice(0, 160)}`);
    }
  };
  await neg("call outside allowed_evm_calls (Token A approve)", tokA, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [relayer.evm as Address, 1n] }));
  await neg("vault function other than trade (pause selector)", vault, encodeFunctionData({ abi: VAULT_ABI, functionName: "pause", args: [noG] }));
  await neg("trade over per-trade cap (150)", vault, tradeData(150n * ONE, 1n));
  await neg("trade above soft limit without guardian (50)", vault, tradeData(50n * ONE, 1n));
  log("selector", TRADE_SELECTOR, "smart", smart.evm, "relayer", relayer.evm);
}

await main();
