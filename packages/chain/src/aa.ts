/**
 * x/abstractaccount helpers: the agent's smart account.
 *
 * Model (SDK-recommended form): the smart account is a PQC-registered chain account that owns itself.
 * The AI agent holds a separate secp256k1 key, linked to that account by its 20-byte address with ONLY the
 * `evm` permission. The account's spending rule bounds every denom and limits EVM calls to exactly
 * `<vault>/<trade selector>`. A relayer submits the agent-signed MsgExecuteEVM and pays fees; inside the
 * EVM the call comes FROM the smart account's address, which is the vault's `executor`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  linkAuthenticatorMsgs, signAuthenticatorLinkEip191, revokeAuthenticatorMsg, buildMetaMaskExecuteEvm,
  fetchSpendingRules, fetchAuthenticators, fetchAuthNonce, resolveEvmAuthDigestVersion, validateSpendingRules,
  type UnifiedAccount, type EncodeObject, type Eip1193Provider, type SpendingRuleInput,
} from "@qorechain/sdk";
import { toFunctionSelector, type Address, type Hex, hexToBytes, bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keyDir } from "./accounts.js";
import { NET, sendMsgs } from "./cosmos.js";

export const TRADE_SELECTOR = toFunctionSelector(
  "trade((bytes32,address,address,address,uint256,uint256),(bytes,bytes,uint256,uint64))",
);

// ------------------------------------------------------------------ agent link key (secp256k1, not a chain account)

interface LinkKeyFile { kind: "qill-agent-link-key"; privateKey: Hex; address: Address }
const linkPath = (name: string) => join(keyDir(), `${name}.link.json`);

export function loadOrCreateLinkKey(name: string): { privateKey: Hex; address: Address; created: boolean } {
  if (existsSync(linkPath(name))) {
    const f = JSON.parse(readFileSync(linkPath(name), "utf8")) as LinkKeyFile;
    if (privateKeyToAccount(f.privateKey).address !== f.address) throw new Error(`${name}: link key mismatch`);
    return { ...f, created: false };
  }
  mkdirSync(keyDir(), { recursive: true });
  const privateKey = bytesToHex(new Uint8Array(randomBytes(32)));
  const address = privateKeyToAccount(privateKey).address;
  writeFileSync(linkPath(name), JSON.stringify({ kind: "qill-agent-link-key", privateKey, address }, null, 2), { mode: 0o600, flag: "wx" });
  return { privateKey, address, created: true };
}

/** EIP-1193 shim so the SDK's MetaMask builder can sign with a local key (personal_sign only). */
export function localProvider(privateKey: Hex): Eip1193Provider {
  const acct = privateKeyToAccount(privateKey);
  return {
    async request({ method, params }) {
      if (method !== "personal_sign") throw new Error(`unsupported ${method}`);
      const [data, addr] = params as [Hex, string];
      if (addr.toLowerCase() !== acct.address.toLowerCase()) throw new Error("wrong signer");
      return acct.signMessage({ message: { raw: data } });
    },
  };
}

// ------------------------------------------------------------------ rules

export interface AgentRuleSpec {
  vault: Address;
  /** uqor; per authorised execution (bounds native outflow of the smart account) */
  perTxLimitUqor: bigint;
  /** uqor per UTC day */
  dailyLimitUqor: bigint;
}

/** The ONE rule the smart account carries. Never `enabled:false`, never an unbounded denom. */
export function agentRule(spec: AgentRuleSpec): SpendingRuleInput {
  if (spec.perTxLimitUqor <= 0n || spec.dailyLimitUqor <= 0n) throw new Error("limits must be > 0");
  if (spec.perTxLimitUqor > spec.dailyLimitUqor) throw new Error("perTx > daily");
  return {
    id: "qill-agent-trade",
    enabled: true,
    perTxLimit: spec.perTxLimitUqor,
    dailyLimit: spec.dailyLimitUqor,
    allowedDenoms: [NET.denom],
    allowedEvmCalls: [`${spec.vault.toLowerCase()}/${TRADE_SELECTOR}`],
    denomLimits: [],
  };
}

/** A 404 "account not found" means no smart-account state yet: no rules, no keys. Anything else throws. */
async function orEmpty<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (e: any) {
    if (/HTTP 404/.test(e.message) && /not found/.test(e.message)) return empty;
    throw e;
  }
}
export async function readRules(account: string) {
  return orEmpty(fetchSpendingRules({ rest: NET.rest, address: account }), { rules: [] } as any);
}
export async function readAuthenticators(account: string) {
  return orEmpty(fetchAuthenticators({ rest: NET.rest, address: account }), [] as any[]);
}

/**
 * Link the agent key with exactly `rule` as the account's full rule set (update-rules replaces ALL rules),
 * in one hybrid tx signed by the smart account. Then read back and diff.
 */
export async function linkAgentKey(smart: UnifiedAccount, agent: { privateKey: Hex; address: Address }, rule: SpendingRuleInput, ttlDays = 7) {
  if (ttlDays <= 0 || ttlDays > 30) throw new Error("expiry must be within 30 days");
  const rules = [rule];
  validateSpendingRules(rules as any);
  const proof = signAuthenticatorLinkEip191({ chainId: NET.chainId, account: smart.cosmos, privateKey: agent.privateKey });
  const msgs = linkAuthenticatorMsgs({
    owner: smart.cosmos,
    chainId: NET.chainId,
    scheme: "secp256k1",
    pubkey: proof.pubkey,
    permissions: ["evm"],
    expiryUnix: Math.floor(Date.now() / 1000) + ttlDays * 86400,
    label: "qill-agent",
    possessionProof: proof.possessionProof,
    spendingRules: rules,
  });
  const res = await sendMsgs(smart, msgs, { gas: 800_000 });
  const back = await readRules(smart.cosmos);
  const auths = await readAuthenticators(smart.cosmos);
  diffRules(rules, back);
  return { txHash: res.transactionHash, rules: back, authenticators: auths };
}

function norm(v: unknown) { return String(v ?? "").toLowerCase(); }
function diffRules(want: SpendingRuleInput[], got: any) {
  const list: any[] = got?.rules ?? got?.spendingRules ?? (Array.isArray(got) ? got : []);
  if (list.length !== want.length) throw new Error(`rules read-back: expected ${want.length}, got ${list.length}: ${JSON.stringify(got)}`);
  want.forEach((w, i) => {
    const g = list[i];
    const checks: [string, unknown, unknown][] = [
      ["id", w.id, g.id], ["enabled", w.enabled, g.enabled],
      ["perTxLimit", w.perTxLimit, g.perTxLimit ?? g.per_tx_limit], ["dailyLimit", w.dailyLimit, g.dailyLimit ?? g.daily_limit],
      ["allowedEvmCalls", (w.allowedEvmCalls ?? []).join(","), (g.allowedEvmCalls ?? g.allowed_evm_calls ?? []).join(",")],
      ["allowedDenoms", (w.allowedDenoms ?? []).join(","), (g.allowedDenoms ?? g.allowed_denoms ?? []).join(",")],
    ];
    for (const [k, a, b] of checks) if (norm(a) !== norm(b)) throw new Error(`rules read-back mismatch on ${k}: want ${a}, got ${b}`);
    if (g.enabled === false) throw new Error("read-back rule is disabled");
  });
}

export async function revokeAgentKey(smart: UnifiedAccount, agentAddress: Address) {
  const msg = revokeAuthenticatorMsg({ owner: smart.cosmos, scheme: "secp256k1", pubkey: hexToBytes(agentAddress) });
  return sendMsgs(smart, [msg], { gas: 500_000 });
}

// ------------------------------------------------------------------ execution

/** Agent signs a MsgExecuteEVM for `to/data`; relayer broadcasts it (hybrid). Fails loudly on execution failure. */
export async function agentExecuteEvm(opts: {
  relayer: UnifiedAccount; smartAccount: string; agent: { privateKey: Hex; address: Address };
  to: Address; data: Hex; gasLimit: bigint;
}) {
  const { nonce } = await fetchAuthNonce({ rest: NET.rest, address: opts.smartAccount, pubkey: opts.agent.address });
  const digestVersion = await resolveEvmAuthDigestVersion({ rest: NET.rest });
  const msg: EncodeObject = await buildMetaMaskExecuteEvm({
    provider: localProvider(opts.agent.privateKey),
    address: opts.agent.address,
    relayer: opts.relayer.cosmos,
    chainId: NET.chainId,
    account: opts.smartAccount,
    to: opts.to,
    value: "0",
    data: hexToBytes(opts.data),
    gasLimit: opts.gasLimit,
    nonce,
    digestVersion,
  });
  const res = await sendMsgs(opts.relayer, [msg], { gas: Number(opts.gasLimit) + 600_000 });
  return { ...res, authNonce: nonce, digestVersion };
}
