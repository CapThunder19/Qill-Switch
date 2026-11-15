/**
 * Qill Switch attack bot: replays every Q-Day Drill attack using ONLY the drill account's ECDSA key.
 *
 * The bot never reads the account's PQC secret. Where an attack needs an ML-DSA key it uses a fresh
 * attacker key, which is what a Q-Day adversary holding just the classical key could do.
 *
 * An attack counts as a SUCCESS if a transaction it sent is included with success status, or if
 * any watched value decreased. Exits 1 if anything succeeded.
 *
 *   pnpm attack                       # all attacks against the drill deployment
 *   pnpm attack --only evm            # one lane: cosmos | evm | vault | agent
 *   pnpm attack --target challenge    # the public "Steal This Agent" deployment: also attacks with the
 *                                     # PUBLISHED agent key (relayed by an account of ours, as an attacker
 *                                     # would relay with their own PQC-registered account)
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWalletClient, http, encodeFunctionData, decodeErrorResult, encodeAbiParameters, parseAbi, bytesToHex,
  type Address, type Hex, zeroAddress, keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  unifiedAccountFromSeed, openEvmWindowMsg, authorizeEvmDelegationMsg, buildRegisterPqcKeyMsg,
  generatePqcKeypair, closeEvmWindowMsg, type EncodeObject, type UnifiedAccount,
} from "@qorechain/sdk";
import { keygen, sign, encodeMessage } from "@qill/pq";
import {
  keyDir, REPO_ROOT, sendMsgs, getBalance, NET, qore, publicClient as pub, VAULT_ABI, evmWindow,
  agentExecuteEvm, loadAccount, accountExists, NO_GUARDIAN,
} from "@qill/chain";

const TARGETS = {
  drill: { key: "drill", deployment: NET.chainId as string, agentKey: undefined, smartAccount: undefined },
  challenge: { key: "challenge", deployment: "challenge", agentKey: "challenge-agent", smartAccount: "challengeagent" },
} as const;
const TARGET_NAME = (process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : "drill") as keyof typeof TARGETS;
const TARGET = TARGETS[TARGET_NAME];
if (!TARGET) throw new Error(`unknown --target ${TARGET_NAME}`);

// ------------------------------------------------------------------ setup: ECDSA key only

const ecdsa = JSON.parse(readFileSync(join(keyDir(), `${TARGET.key}.ecdsa.json`), "utf8")) as { privateKey: Hex; evm: Address; cosmos: string };
const attackerPqcSecret = new Uint8Array(randomBytes(32)); // NOT the real one
const attacker: UnifiedAccount = unifiedAccountFromSeed(Buffer.from(ecdsa.privateKey.slice(2), "hex"), { pqcSecret: attackerPqcSecret });
if (attacker.cosmos !== ecdsa.cosmos) throw new Error("address mismatch");
const eoa = privateKeyToAccount(ecdsa.privateKey);
const wallet = createWalletClient({ account: eoa, chain: qore, transport: http() });

const D = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${TARGET.deployment}.json`), "utf8")).contracts;
const VAULT = D.QillVault as Address;
const POOL = D.MockPool as Address;
const TOKA = D.TokenA as Address;
const TOKB = D.TokenB as Address;
const SINK = JSON.parse(readFileSync(join(keyDir(), "funder.ecdsa.json"), "utf8")) as { cosmos: string; evm: Address }; // our own account
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
]);

// ------------------------------------------------------------------ scoreboard

type Outcome = "blocked" | "SUCCESS";
interface Result { lane: string; name: string; outcome: Outcome; detail: string }
const results: Result[] = [];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;

function short(e: unknown): string {
  // deepest message in the viem error chain (the node's own reason)
  let c: any = e, m = '';
  while (c) { m = c.details || c.shortMessage || c.message || m; c = c.cause; }
  m = String(m).replace(/^failed to broadcast transaction: /, '').replace(/; open one with MsgOpenEVMWindow.*/, '');
  // the SDK labels pqc/20 and pqc/21 with generic sdk-codespace text; show the chain's own reason instead
  const pqc = m.match(/pqc\/\d+:.*/);
  if (pqc) m = pqc[0];
  return m.replace(/\s+/g, ' ').slice(0, 110);
}

/** Decode a QillVault custom error from a revert. */
function revertReason(e: unknown): string {
  let c: any = e;
  while (c) {
    const data = typeof c.data === 'string' ? c.data : c.data?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try { const d = decodeErrorResult({ abi: VAULT_ABI, data: data as Hex }); return d.errorName + (d.args?.length ? '(' + d.args.join(',') + ')' : ''); }
      catch { return 'selector ' + data.slice(0, 10); }
    }
    c = c.cause;
  }
  return short(e);
}

async function attack(lane: string, name: string, fn: () => Promise<{ success: boolean; detail: string }>) {
  if (only && only !== lane) return;
  try {
    const r = await fn();
    results.push({ lane, name, outcome: r.success ? "SUCCESS" : "blocked", detail: r.detail });
  } catch (e) {
    results.push({ lane, name, outcome: "blocked", detail: short(e) });
  }
  const r = results[results.length - 1];
  console.log(`${r.outcome === "SUCCESS" ? "!!" : "ok"} [${lane}] ${name.padEnd(46)} ${r.outcome.padEnd(8)} ${r.detail}`);
}

/** Cosmos-lane tx: success iff included with code 0 (sendMsgs throws otherwise). */
async function cosmos(msgs: EncodeObject[], mode: "classical" | "forged-hybrid") {
  const r = await sendMsgs(attacker, msgs, { classical: mode === "classical", gas: 600_000 });
  return { success: true, detail: `INCLUDED ${r.transactionHash}` };
}

/** EVM tx from the drill EOA: success iff mined with status success. */
async function evmSend(tx: { to: Address | null; data?: Hex; value?: bigint; gas?: bigint; authorizationList?: any }) {
  const h = await wallet.sendTransaction({ ...tx, gas: tx.gas ?? 500_000n } as any);
  const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
  return { success: r.status === "success", detail: `${r.status.toUpperCase()} ${h}` };
}

/** Vault call: simulate (must revert) AND broadcast (must be refused or revert). */
async function vaultCall(data: Hex) {
  let sim = "simulation passed";
  try { await pub.call({ account: eoa.address, to: VAULT, data }); } catch (e) { sim = "reverts " + revertReason(e); }
  try {
    const r = await evmSend({ to: VAULT, data, gas: 1_500_000n });
    return { success: r.success, detail: `${sim} | ${r.detail}` };
  } catch (e) {
    return { success: false, detail: `${sim} | send refused: ${short(e).slice(0, 60)}` };
  }
}

// ------------------------------------------------------------------ value snapshot

async function snapshot() {
  const tb = (t: Address, who: Address) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  return {
    drillNativeUqor: await getBalance(ecdsa.cosmos),
    smartAccountUqor: TARGET.smartAccount && accountExists(TARGET.smartAccount) ? await getBalance(loadAccount(TARGET.smartAccount).cosmos) : 0n,
    vaultNativeWei: await pub.getBalance({ address: VAULT }),
    vaultA: await tb(TOKA, VAULT), vaultB: await tb(TOKB, VAULT),
    poolA: await tb(TOKA, POOL), poolB: await tb(TOKB, POOL),
    ownerNonce: (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "ownerNonce" })) as bigint,
    paused: (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "paused" })) as boolean,
    executor: (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "executor" })) as Address,
    ownerKeyHash: (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "ownerKeyHash" })) as Hex,
  };
}

// ------------------------------------------------------------------ attacks

async function cosmosAttacks() {
  const bank = (amt: string): EncodeObject => ({ typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: attacker.cosmos, toAddress: SINK.cosmos, amount: [{ denom: "uqor", amount: amt }] } });
  const win = (targets?: string[]) => openEvmWindowMsg({ sender: attacker.cosmos, blocks: 1000, maxTxs: 100, maxValue: 10_000_000_000n, ...(targets ? { allowedTargets: targets } : {}) });

  await attack("cosmos", "native transfer (classical sig)", () => cosmos([bank("1000000")], "classical"));
  await attack("cosmos", "native transfer (forged hybrid, attacker ML-DSA)", () => cosmos([bank("1000000")], "forged-hybrid"));
  await attack("cosmos", "open EVM window, unscoped (classical)", () => cosmos([win()], "classical"));
  await attack("cosmos", "open EVM window, unscoped (forged hybrid)", () => cosmos([win()], "forged-hybrid"));
  await attack("cosmos", "open EVM window scoped to tokens (classical)", () => cosmos([win([TOKA, TOKB])], "classical"));
  await attack("cosmos", "register attacker PQC key (classical)", () =>
    cosmos([buildRegisterPqcKeyMsg(attacker.cosmos, { pqcKeypair: generatePqcKeypair() })], "classical"));
  await attack("cosmos", "EIP-7702 delegation consent (classical)", () =>
    cosmos([authorizeEvmDelegationMsg({ sender: attacker.cosmos, delegate: SINK.evm, blocks: 100 })], "classical"));
  await attack("cosmos", "EIP-7702 delegation consent (forged hybrid)", () =>
    cosmos([authorizeEvmDelegationMsg({ sender: attacker.cosmos, delegate: SINK.evm, blocks: 100 })], "forged-hybrid"));
  await attack("cosmos", "close EVM window (classical, griefing)", () => cosmos([closeEvmWindowMsg(attacker.cosmos)], "classical"));
}

async function evmAttacks() {
  await attack("evm", "native QOR transfer", () => evmSend({ to: SINK.evm, value: 10n ** 17n, gas: 21_000n }));
  await attack("evm", "Token A approve(attacker, max)", () =>
    evmSend({ to: TOKA, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [SINK.evm, 2n ** 256n - 1n] }) }));
  await attack("evm", "Token A transferFrom(vault)", () =>
    evmSend({ to: TOKA, data: encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args: [VAULT, SINK.evm, 1n] }) }));
  await attack("evm", "deploy contract", () => evmSend({ to: null, data: "0x6080604052348015600f57600080fd5b50" }));
  await attack("evm", "EIP-7702 type-4 delegation tx", async () => {
    const nonce = await pub.getTransactionCount({ address: eoa.address, blockTag: "pending" });
    const authorization = await wallet.signAuthorization({ contractAddress: SINK.evm, nonce: nonce + 1 } as any);
    return evmSend({ to: eoa.address, authorizationList: [authorization], gas: 100_000n });
  });
}

const JUNK_PK = bytesToHex(new Uint8Array(randomBytes(2592)));
const JUNK_SIG = bytesToHex(new Uint8Array(randomBytes(4627)));

async function vaultAttacks() {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "ownerNonce" })) as bigint;
  const realOwnerPkHash = (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "ownerKeyHash" })) as Hex;

  // the real owner pubkey is public (it's in every owner tx's calldata). Pull it + the used pause signature from chain.
  const pauseTx = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${NET.chainId}.json`), "utf8")).ownerTxs?.pause as Hex | undefined;
  let realPk: Hex | undefined, usedAuth: any;
  if (pauseTx) {
    const tx = await pub.getTransaction({ hash: pauseTx });
    const { decodeFunctionData } = await import("viem");
    const d = decodeFunctionData({ abi: VAULT_ABI, data: tx.input });
    usedAuth = (d.args as any[])[0];
    realPk = usedAuth.pubkey;
    if (keccak256(realPk!) !== realOwnerPkHash) realPk = undefined;
  }
  const auth = (o: Partial<{ pubkey: Hex; signature: Hex; nonce: bigint; expiry: bigint }> = {}) =>
    ({ pubkey: realPk ?? JUNK_PK, signature: JUNK_SIG, nonce, expiry: now + 600n, ...o });
  const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: VAULT_ABI, functionName: fn, args });

  await attack("vault", "withdraw native, junk signature", () => vaultCall(call("withdraw", [auth(), SINK.evm, zeroAddress, 1n])));
  await attack("vault", "withdraw Token A, junk signature", () => vaultCall(call("withdraw", [auth(), SINK.evm, TOKA, 10n ** 18n])));
  await attack("vault", "withdraw, attacker ML-DSA key + VALID sig", () => {
    const kp = keygen();
    const params = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [SINK.evm, TOKA, 10n ** 18n]);
    const msg = encodeMessage({ chainId: 9800n, verifyingContract: VAULT, action: "WITHDRAW", params, nonce, expiry: now + 600n });
    return vaultCall(call("withdraw", [{ pubkey: bytesToHex(kp.publicKey), signature: bytesToHex(sign(msg, kp.secretKey)), nonce, expiry: now + 600n }, SINK.evm, TOKA, 10n ** 18n]));
  });
  await attack("vault", "setExecutor(attacker), junk signature", () => vaultCall(call("setExecutor", [auth(), eoa.address])));
  await attack("vault", "resume, junk signature", () => vaultCall(call("resume", [auth()])));
  await attack("vault", "rotateOwnerKey(attacker), junk signature", () => vaultCall(call("rotateOwnerKey", [auth(), keccak256(JUNK_PK)])));
  await attack("vault", "setGuardianKey(attacker), junk signature", () => vaultCall(call("setGuardianKey", [auth(), keccak256(JUNK_PK)])));
  await attack("vault", "setAllowlist(attacker pool), junk signature", () => vaultCall(call("setAllowlist", [auth(), 1, eoa.address, true])));
  await attack("vault", "qDay (griefing), junk signature", () => vaultCall(call("qDay", [auth()])));
  await attack("vault", "pause (griefing), junk signature", () => vaultCall(call("pause", [auth()])));
  await attack("vault", "createMandate(attacker), junk signature", () => vaultCall(call("createMandate", [auth(), {
    id: keccak256(toHex("evil")), textHash: keccak256("0x"), rulesHash: keccak256("0x"), expiry: now + 86400n,
    pools: [POOL], tokens: [TOKA, TOKB], perTradeCap: [10n ** 30n, 10n ** 30n], dailyCap: [10n ** 30n, 10n ** 30n], softLimit: [10n ** 30n, 10n ** 30n] }])));
  if (usedAuth) {
    await attack("vault", "REPLAY real owner pause signature on resume", () => vaultCall(call("resume", [usedAuth])));
    await attack("vault", "REPLAY real owner pause signature on pause", () => vaultCall(call("pause", [usedAuth])));
    await attack("vault", "real sig, expiry stretched", () => vaultCall(call("pause", [{ ...usedAuth, expiry: now + 10n ** 6n }])));
  }
  const trade = (o: Record<string, unknown>) => ({ mandateId: keccak256(toHex("any")), pool: POOL, tokenIn: TOKA, tokenOut: TOKB, amountIn: 10n ** 18n, minOut: 0n, ...o });
  const noG = { pubkey: "0x", signature: "0x", nonce: 0n, expiry: 0n };
  await attack("vault", "trade (not executor)", () => vaultCall(call("trade", [trade({}), noG])));
  await attack("vault", "trade over cap", () => vaultCall(call("trade", [trade({ amountIn: 10n ** 24n }), noG])));
  await attack("vault", "trade via attacker 'pool'", () => vaultCall(call("trade", [trade({ pool: eoa.address }), noG])));
  await attack("vault", "send native to vault + junk", () => evmSend({ to: VAULT, value: 1n, gas: 50_000n }));
}

async function agentKeyAttacks() {
  if (!TARGET.agentKey || !TARGET.smartAccount) return;
  // the published agent key, read from its file exactly as an attacker would copy it from the challenge page
  const agent = JSON.parse(readFileSync(join(keyDir(), `${TARGET.agentKey}.link.json`), "utf8")) as { privateKey: Hex; address: Address };
  const smart = loadAccount(TARGET.smartAccount).cosmos;
  const relayer = loadAccount("relayer"); // stands in for the attacker's own PQC-registered relayer
  const exec = async (to: Address, data: Hex, value?: bigint) => {
    const r = await agentExecuteEvm({ relayer, smartAccount: smart, agent, to, data, gasLimit: 400_000n, value });
    return { success: true, detail: `EXECUTED ${r.transactionHash}` };
  };
  const trade = (o: Record<string, unknown>) => ({ mandateId: keccak256(toHex("any")), pool: POOL, tokenIn: TOKA, tokenOut: TOKB, amountIn: 10n ** 18n, minOut: 0n, ...o });
  const n = Number(await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "mandateCount" }));
  const mid = n ? ((await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "mandateIds", args: [BigInt(n - 1)] })) as Hex) : keccak256(toHex("none"));
  const call = (fn: string, args: unknown[]) => encodeFunctionData({ abi: VAULT_ABI, functionName: fn, args });

  await attack("agent", "agent key: send 0.1 QOR to attacker", () => exec(SINK.evm, "0x", 10n ** 17n));
  await attack("agent", "agent key: send 1 uqor (within rule)", () => exec(SINK.evm, "0x", 10n ** 12n));
  await attack("agent", "agent key: Token A approve(attacker)", () => exec(TOKA, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [SINK.evm, 2n ** 255n] })));
  await attack("agent", "agent key: vault.withdraw (junk sig)", () => exec(VAULT, call("withdraw", [{ pubkey: JUNK_PK, signature: JUNK_SIG, nonce: 0n, expiry: 2n ** 40n }, SINK.evm, TOKA, 1n])));
  await attack("agent", "agent key: trade, no guardian (soft limit 0)", () => exec(VAULT, call("trade", [trade({ mandateId: mid }), NO_GUARDIAN])));
  await attack("agent", "agent key: trade, junk guardian sig", () => exec(VAULT, call("trade", [trade({ mandateId: mid }), { pubkey: JUNK_PK, signature: JUNK_SIG, nonce: 0n, expiry: 2n ** 40n }])));
  await attack("agent", "agent key: trade into attacker 'pool'", () => exec(VAULT, call("trade", [trade({ mandateId: mid, pool: SINK.evm }), NO_GUARDIAN])));
}

// ------------------------------------------------------------------ run

async function main() {
  console.log(`attack bot [${TARGET_NAME}] | target ${NET.chainId} | drill ${eoa.address} (${ecdsa.cosmos}) | vault ${VAULT}`);
  const w = await evmWindow(ecdsa.cosmos);
  console.log(`drill EVM window: found=${w.found} live=${w.live}\n`);
  const before = await snapshot();
  await cosmosAttacks();
  await evmAttacks();
  await vaultAttacks();
  await agentKeyAttacks();
  const after = await snapshot();

  const decreased = (Object.keys(before) as (keyof typeof before)[]).filter((k) =>
    typeof before[k] === "bigint" && k !== "ownerNonce" && (after[k] as bigint) < (before[k] as bigint));
  const controlChanged = before.ownerNonce !== after.ownerNonce || before.paused !== after.paused
    || before.executor !== after.executor || before.ownerKeyHash !== after.ownerKeyHash;
  const successes = results.filter((r) => r.outcome === "SUCCESS");
  const valueMoved = before.drillNativeUqor - after.drillNativeUqor;

  console.log("\n================ SCOREBOARD ================");
  console.log(`attempts:          ${results.length}`);
  console.log(`successes:         ${successes.length}`);
  console.log(`value moved:       drill ${Number(valueMoved) / 1e6} QOR; vault/pool decreased: ${decreased.length ? decreased.join(",") : "none"}`);
  console.log(`vault control:     ${controlChanged ? "CHANGED" : "unchanged"} (nonce ${after.ownerNonce}, paused ${after.paused}, executor ${after.executor})`);
  console.log("=============================================");
  const bad = successes.length > 0 || decreased.length > 0 || controlChanged || valueMoved > 0n;
  process.exitCode = bad ? 1 : 0;

  // scoreboard + every attempt, for the dashboard's attack log
  mkdirSync(join(REPO_ROOT, "logs"), { recursive: true });
  appendFileSync(join(REPO_ROOT, "logs", "attacks.jsonl"), JSON.stringify({
    ts: new Date().toISOString(), target: VAULT, drill: eoa.address, attempts: results.length, successes: successes.length,
    valueMovedUqor: valueMoved.toString(), controlChanged, results,
  }) + "\n");
}

await main();
