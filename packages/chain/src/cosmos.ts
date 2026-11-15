/**
 * Cosmos-lane helpers for a unified eth_secp256k1 account, built on @qorechain/sdk.
 * Every tx is HYBRID-signed (secp256k1 + ML-DSA-87) except the one-time PQC key registration,
 * which the chain exempts as the documented bootstrap.
 */
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  signProofOfPossession,
  fetchPqcStatus,
  fetchEvmWindow,
  pqcStatusPublicKey,
  openEvmWindowMsg,
  closeEvmWindowMsg,
  EXECUTION_FAILED_EVENT,
  type UnifiedAccount,
  type EthBroadcaster,
  type EncodeObject,
  type StdFee,
} from "@qorechain/sdk";
import { bytesToHex } from "viem";

export const NET = {
  chainId: process.env.QORE_CHAIN_ID ?? "qorechain-diana",
  rest: (process.env.QORE_REST || "https://api-testnet.qore.host").replace(/\/$/, ""),
  evmRpc: process.env.QORE_EVM_RPC || "https://evm-testnet.qore.host",
  evmChainId: 9800,
  denom: "uqor",
} as const;

async function getJson<T = any>(path: string): Promise<T> {
  const r = await fetch(NET.rest + path);
  const body = await r.text();
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

// ------------------------------------------------------------------ reads

export async function getBalance(cosmos: string, denom: string = NET.denom): Promise<bigint> {
  const j = await getJson(`/cosmos/bank/v1beta1/balances/${cosmos}/by_denom?denom=${encodeURIComponent(denom)}`);
  return BigInt(j.balance?.amount ?? "0");
}

/** Account number + sequence, or null if the account does not exist on chain yet. */
export async function getAccountInfo(cosmos: string): Promise<{ accountNumber: bigint; sequence: bigint } | null> {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${cosmos}`);
  if (r.status === 404) return null;
  const j: any = await r.json();
  if (!r.ok) {
    if (String(j?.message ?? "").includes("not found")) return null;
    throw new Error(`account query failed: ${JSON.stringify(j).slice(0, 300)}`);
  }
  const a = j.account?.base_account ?? j.account;
  return { accountNumber: BigInt(a.account_number ?? 0), sequence: BigInt(a.sequence ?? 0) };
}

export async function pqcStatus(cosmos: string) {
  const s = await fetchPqcStatus({ rest: NET.rest, address: cosmos });
  const pk = pqcStatusPublicKey(s);
  return { registered: s.registered, publicKey: pk ? bytesToHex(pk) : undefined, raw: s };
}

export async function evmWindow(cosmos: string) {
  return fetchEvmWindow({ rest: NET.rest, address: cosmos });
}

export async function evmLimits() {
  return getJson("/qorechain/pqc/v1/evm_limits");
}

// ------------------------------------------------------------------ broadcast

/** REST broadcast transport (sync) that waits for inclusion. */
export const restBroadcaster: EthBroadcaster = {
  async broadcastTx(tx: Uint8Array, timeoutMs = 60_000, pollMs = 1_500) {
    const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_bytes: Buffer.from(tx).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
    });
    const j: any = await r.json();
    const resp = j.tx_response;
    if (!resp) throw new Error(`broadcast failed: ${JSON.stringify(j).slice(0, 500)}`);
    if (resp.code !== 0) {
      return { code: resp.code, transactionHash: resp.txhash, rawLog: `${resp.codespace}/${resp.code}: ${resp.raw_log}` };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, pollMs));
      const q = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${resp.txhash}`);
      if (q.status !== 200) continue;
      const t: any = (await q.json()).tx_response;
      lastTx.set(resp.txhash, t);
      return {
        code: t.code,
        transactionHash: t.txhash,
        height: Number(t.height),
        gasUsed: BigInt(t.gas_used),
        gasWanted: BigInt(t.gas_wanted),
        rawLog: t.code ? `${t.codespace}/${t.code}: ${t.raw_log}` : t.raw_log,
      };
    }
    throw new Error(`tx ${resp.txhash} not included within ${timeoutMs}ms`);
  },
};
const lastTx = new Map<string, any>();

export class TxFailed extends Error {
  constructor(msg: string, readonly txHash?: string) { super(msg); }
}

export interface SendOpts {
  gas?: number;
  memo?: string;
  /** Only for the bootstrap PQC registration. */
  classical?: boolean;
  gasPriceUqor?: number;
}

/**
 * Sign (hybrid by default) and broadcast `messages`, wait for inclusion, and fail loudly on a non-zero
 * code OR an `abstractaccount_execution_failed` event (which comes back with code 0).
 */
export async function sendMsgs(acct: UnifiedAccount, messages: EncodeObject[], opts: SendOpts = {}) {
  const info = await getAccountInfo(acct.cosmos);
  if (!info) throw new TxFailed(`account ${acct.cosmos} does not exist on chain (no funds yet)`);
  const gas = opts.gas ?? 600_000;
  const price = opts.gasPriceUqor ?? 0.15;
  const fee: StdFee = { amount: [{ denom: NET.denom, amount: String(Math.ceil(gas * price)) }], gas: String(gas) };
  const signer = new EthNativeSigner(acct, { signMode: opts.classical ? "classical" : "hybrid", rest: NET.rest });
  const res = await signer.signAndBroadcast(restBroadcaster, {
    chainId: NET.chainId,
    accountNumber: info.accountNumber,
    sequence: info.sequence,
    messages,
    fee,
    memo: opts.memo ?? "",
  });
  if (res.code !== 0) throw new TxFailed(`tx failed: ${res.rawLog}`, res.transactionHash);
  const full = lastTx.get(res.transactionHash);
  const events: any[] = full?.events ?? [];
  const failed = events.filter((e) => e.type === EXECUTION_FAILED_EVENT);
  if (failed.length) {
    const reasons = failed.map((e) => (e.attributes ?? []).find((a: any) => a.key === "reason")?.value ?? "?").join("; ");
    throw new TxFailed(`${EXECUTION_FAILED_EVENT} (${reasons}) in ${res.transactionHash}`, res.transactionHash);
  }
  return { ...res, events };
}

// ------------------------------------------------------------------ PQC registration

/** Register the account's ML-DSA-87 key (MsgRegisterPQCKeyV2 + proof of possession). Idempotent. */
export async function registerPqcKey(acct: UnifiedAccount, opts: { withPoP?: boolean } = {}) {
  const st = await pqcStatus(acct.cosmos);
  if (st.registered) {
    if (st.publicKey && st.publicKey !== bytesToHex(acct.pqc.publicKey))
      throw new Error(`account ${acct.cosmos} has a DIFFERENT PQC key registered`);
    return { alreadyRegistered: true as const };
  }
  const proofOfPossession =
    opts.withPoP === false
      ? undefined
      : signProofOfPossession({ chainId: NET.chainId, account: acct.cosmos, keypair: acct.pqc, algorithmId: 1 });
  const msg = buildRegisterPqcKeyMsg(acct.cosmos, {
    pqcKeypair: acct.pqc,
    ecdsaPubkey: Buffer.from(acct.publicKey.slice(2), "hex"),
    proofOfPossession,
  });
  const res = await sendMsgs(acct, [msg], { classical: true, gas: 600_000 });
  return { alreadyRegistered: false as const, txHash: res.transactionHash };
}

// ------------------------------------------------------------------ bank

export async function bankSend(from: UnifiedAccount, to: string, amountUqor: bigint) {
  const msg: EncodeObject = {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: from.cosmos, toAddress: to, amount: [{ denom: NET.denom, amount: amountUqor.toString() }] },
  };
  return sendMsgs(from, [msg], { gas: 500_000 });
}

// ------------------------------------------------------------------ EVM windows

export interface WindowSpec {
  blocks: number;
  maxTxs: number;
  /** uqor: value + max fees of every admitted tx */
  maxValue: bigint;
  /** Contracts the window may call. Required unless `allowContractCreation` (deploy only). */
  allowedTargets?: string[];
  /** Deploy-only escape hatch: an unscoped window (scoped windows refuse contract creation). */
  allowContractCreation?: boolean;
  nativeOnly?: boolean;
}

export async function openWindow(acct: UnifiedAccount, w: WindowSpec) {
  if (!w.allowContractCreation && !w.nativeOnly && !(w.allowedTargets && w.allowedTargets.length))
    throw new Error("refusing to open an unscoped EVM window: pass allowedTargets");
  if (w.blocks > 600) throw new Error("refusing a window longer than 600 blocks (~15 min)");
  const msg = openEvmWindowMsg({
    sender: acct.cosmos,
    blocks: w.blocks,
    maxTxs: w.maxTxs,
    maxValue: w.maxValue,
    ...(w.allowedTargets?.length ? { allowedTargets: w.allowedTargets } : {}),
    ...(w.nativeOnly ? { nativeOnly: true } : {}),
  });
  return sendMsgs(acct, [msg], { gas: 600_000 });
}

/** Close the window and verify it is gone (or no longer live). */
export async function closeWindow(acct: UnifiedAccount) {
  const before = await evmWindow(acct.cosmos);
  let txHash: string | undefined;
  if (before.found) txHash = (await sendMsgs(acct, [closeEvmWindowMsg(acct.cosmos)], { gas: 500_000 })).transactionHash;
  const after = await evmWindow(acct.cosmos);
  if (after.found && after.live) throw new Error(`window for ${acct.cosmos} still live after close`);
  return { txHash, closed: true };
}

// ------------------------------------------------------------------ account bootstrap

/**
 * Create (if needed), register the ML-DSA-87 key while holding only the registration fee, then top up to `targetUqor`.
 * Idempotent.
 */
export async function ensureAccount(name: string, targetUqor: bigint, funderName = "funder") {
  const { accountExists, generateAccount, loadAccount } = await import("./accounts.js");
  const BOOT = 150_000n;
  if (!accountExists(name)) generateAccount(name);
  const a = loadAccount(name);
  const funder = loadAccount(funderName);
  if (!(await pqcStatus(a.cosmos)).registered) {
    const bal = await getBalance(a.cosmos);
    if (bal < BOOT) await bankSend(funder, a.cosmos, BOOT - bal);
    await registerPqcKey(a);
  }
  const bal = await getBalance(a.cosmos);
  if (bal < targetUqor) await bankSend(funder, a.cosmos, targetUqor - bal);
  return a;
}
