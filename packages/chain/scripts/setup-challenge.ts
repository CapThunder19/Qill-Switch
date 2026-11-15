/**
 * "Steal This Agent" setup. Idempotent. Never touches the drill or demo deployments.
 *
 *   challenge       chain account with bait QOR. Its classical ECDSA key is PUBLISHED; its ML-DSA key is not.
 *   challengeagent  the agent's smart account (vault executor). Swept to 0 QOR after setup.
 *   challenge-agent the agent's linked secp256k1 key (evm permission only). PUBLISHED.
 *   deployment "challenge": tokens + pool + QillVault(executor = challengeagent)
 *   mandate: tiny caps and soft limit 0, so EVERY trade needs our guardian's ML-DSA-87 co-signature.
 *
 * Writes apps/challenge/public/challenge.json (public: addresses, the two published keys, baseline values).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, parseAbi, toHex, type Address } from "viem";
import { REPO_ROOT, keyDir, loadAccount } from "../src/accounts.js";
import { ensureAccount, getBalance, bankSend, evmWindow } from "../src/cosmos.js";
import { agentRule, linkAgentKey, loadOrCreateLinkKey, readAuthenticators, readRules } from "../src/aa.js";
import { publicClient as pub, VAULT_ABI, relayToVault, signOwnerCommand, type MandateParams } from "../src/vault.js";

const TEXT = "Steal This Agent: trade QTA and QTB on demo-pool. Max 10 per trade, 20 per day, guardian above 0, for 30 days.";
const ONE = 10n ** 18n;
const FEE = 75_000n; // 500k gas × 0.15 uqor

const challenge = await ensureAccount("challenge", 3_000_000n);
const smart = await ensureAccount("challengeagent", 400_000n);
console.log("challenge account", challenge.cosmos, challenge.evm, "| smart account", smart.cosmos, smart.evm);

// deployment
const depFile = join(REPO_ROOT, "deployments", "challenge.json");
if (!existsSync(depFile)) {
  const out = execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "packages/chain/scripts/deploy.ts"),
    "--deployer", "relayer", "--executor", smart.evm, "--name", "challenge", "--execute"], { cwd: join(REPO_ROOT, "packages/chain"), encoding: "utf8" });
  console.log(out.split("\n").filter((l) => /checks|wrote|window closed/.test(l)).join("\n"));
}
const dep = JSON.parse(readFileSync(depFile, "utf8"));
const C = dep.contracts as Record<string, Address>;
const vault = C.QillVault!;

// agent key + rule (1 uqor native per execution / per day; calls only vault.trade)
const agent = loadOrCreateLinkKey("challenge-agent");
const keys = (await readAuthenticators(smart.cosmos)) as any[];
if (!keys.some((k) => !k.revoked)) {
  if ((await getBalance(smart.cosmos)) < 200_000n) await bankSend(loadAccount("funder"), smart.cosmos, 300_000n);
  const r = await linkAgentKey(smart, agent, agentRule({ vault, perTxLimitUqor: 1n, dailyLimitUqor: 1n }), 30);
  console.log("linked challenge-agent", agent.address, r.txHash);
}

// mandate (soft limit 0 → every trade needs the guardian)
const n = Number(await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "mandateCount" }));
let mandateId: string;
if (n === 0) {
  const rulesJson = JSON.stringify({ challenge: true, vault: vault.toLowerCase(), perTrade: "10", daily: "20", soft: "0", smartAccountRule: await readRules(smart.cosmos) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const textHash = keccak256(toHex(TEXT));
  const rulesHash = keccak256(toHex(rulesJson));
  const p: MandateParams = {
    id: keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [textHash, rulesHash])),
    textHash, rulesHash, expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400 - 600),
    pools: [C.MockPool!], tokens: [C.TokenA!, C.TokenB!],
    perTradeCap: [10n * ONE, 10n * ONE], dailyCap: [20n * ONE, 20n * ONE], softLimit: [0n, 0n],
  };
  const { data } = await signOwnerCommand(vault, "createMandate", [p]);
  const r = await relayToVault(vault, data, "relayer");
  mkdirSync(join(REPO_ROOT, "mandates"), { recursive: true });
  writeFileSync(join(REPO_ROOT, "mandates", `${p.id}.json`), JSON.stringify({ deployment: "challenge", text: TEXT, rulesJson, textHash, rulesHash,
    vaultParams: p, draft: { template: "swap", schedule: null } }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  mandateId = p.id;
  console.log("mandate", p.id, "tx", r.hash);
} else {
  mandateId = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "mandateIds", args: [BigInt(n - 1)] })) as string;
}

// sweep the smart account to exactly 0 so the agent key has no native value to move
const sb = await getBalance(smart.cosmos);
if (sb > FEE) {
  await bankSend(smart, loadAccount("funder").cosmos, sb - FEE);
  console.log("swept smart account; balance now", (await getBalance(smart.cosmos)).toString(), "uqor");
}

// baseline + public config
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (t: Address, who: Address) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const ecdsa = JSON.parse(readFileSync(join(keyDir(), "challenge.ecdsa.json"), "utf8"));
const cfg = {
  title: "Steal This Agent",
  network: { name: "qorechain-diana", evmChainId: 9800, evmRpc: "https://evm-testnet.qore.host" },
  publishedKeys: {
    challengeAccount: { what: "classical ECDSA key of the challenge account (holds the bait QOR)", privateKey: ecdsa.privateKey, evm: challenge.evm, cosmos: challenge.cosmos },
    agentKey: { what: "the AI agent's linked secp256k1 key (evm permission, rule: only vault.trade, 1 uqor native/day)", privateKey: agent.privateKey, address: agent.address },
  },
  smartAccount: { evm: smart.evm, cosmos: smart.cosmos },
  contracts: C,
  mandate: { id: mandateId, text: TEXT },
  baseline: {
    at: new Date().toISOString(),
    challengeAccountWei: (await pub.getBalance({ address: challenge.evm as Address })).toString(),
    challengeAccountNonce: await pub.getTransactionCount({ address: challenge.evm as Address }),
    smartAccountWei: (await pub.getBalance({ address: smart.evm as Address })).toString(),
    vaultQTA: (await bal(C.TokenA!, vault)).toString(), vaultQTB: (await bal(C.TokenB!, vault)).toString(),
    poolQTA: (await bal(C.TokenA!, C.MockPool!)).toString(), poolQTB: (await bal(C.TokenB!, C.MockPool!)).toString(),
    ownerNonce: Number(await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "ownerNonce" })),
  },
};
const out = join(REPO_ROOT, "apps/challenge/public/challenge.json");
mkdirSync(join(REPO_ROOT, "apps/challenge/public"), { recursive: true });
writeFileSync(out, JSON.stringify(cfg, null, 2));
const windows = await Promise.all(["challenge", "challengeagent", "relayer"].map(async (a) => `${a}:${(await evmWindow(loadAccount(a).cosmos)).live}`));
console.log("wrote", out, "| windows live:", windows.join(" "));
