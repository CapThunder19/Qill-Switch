/**
 * QillVault client: builds owner-signed (ML-DSA-87) commands and relays them through a window
 * scoped to the vault only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, encodeFunctionData,
  bytesToHex, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmWindowCost } from "@qorechain/evm/window";
import { actionId, encodeMessage, sign, readKeyFile, type ActionName, type MlDsaKeypair } from "@qill/pq";
import { REPO_ROOT, keyDir, loadAccount } from "./accounts.js";
import { NET, openWindow, closeWindow, evmWindow } from "./cosmos.js";

export const qore = defineChain({
  id: NET.evmChainId, name: NET.chainId, nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evmRpc] } },
});
export const publicClient = createPublicClient({ chain: qore, transport: http() });

export const VAULT_ABI: Abi = JSON.parse(
  readFileSync(join(REPO_ROOT, "contracts/artifacts/src/QillVault.sol/QillVault.json"), "utf8"),
).abi;

export function deployment(): { contracts: Record<string, Address> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${NET.chainId}.json`), "utf8"));
}

export function ownerKey(): MlDsaKeypair {
  return readKeyFile(join(keyDir(), "owner.mldsa.json"), { repoRoot: REPO_ROOT });
}

export type OwnerAuth = { pubkey: Hex; signature: Hex; nonce: bigint; expiry: bigint };

/** Owner commands: Solidity function name, action id, params ABI. */
export const COMMANDS = {
  pause: { fn: "pause", action: "PAUSE", types: [] },
  resume: { fn: "resume", action: "RESUME", types: [] },
  qDay: { fn: "qDay", action: "Q_DAY", types: [] },
  setExecutor: { fn: "setExecutor", action: "SET_EXECUTOR", types: [{ type: "address" }] },
  withdraw: { fn: "withdraw", action: "WITHDRAW", types: [{ type: "address" }, { type: "address" }, { type: "uint256" }] },
  revokeMandate: { fn: "revokeMandate", action: "REVOKE_MANDATE", types: [{ type: "bytes32" }] },
  setGuardianKey: { fn: "setGuardianKey", action: "SET_GUARDIAN_KEY", types: [{ type: "bytes32" }] },
  rotateOwnerKey: { fn: "rotateOwnerKey", action: "ROTATE_OWNER_KEY", types: [{ type: "bytes32" }] },
} as const satisfies Record<string, { fn: string; action: ActionName; types: readonly { type: string }[] }>;
export type CommandName = keyof typeof COMMANDS;

/** Sign `cmd(args)` for `vault` at its current ownerNonce. */
export async function signOwnerCommand(vault: Address, cmd: CommandName, args: readonly unknown[], ttlSec = 600) {
  const c = COMMANDS[cmd];
  const kp = ownerKey();
  const nonce = (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "ownerNonce" })) as bigint;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + ttlSec);
  const params = c.types.length ? encodeAbiParameters(c.types as any, args as any) : "0x";
  const message = encodeMessage({ chainId: BigInt(NET.evmChainId), verifyingContract: vault, action: c.action, params, nonce, expiry });
  // cross-check against the contract's own encoder
  const onchain = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "ownerMessage",
    args: [actionId(c.action), params, expiry] });
  if (onchain !== message) throw new Error("local message encoding differs from vault.ownerMessage");
  const auth: OwnerAuth = { pubkey: bytesToHex(kp.publicKey), signature: bytesToHex(sign(message, kp.secretKey)), nonce, expiry };
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: c.fn, args: [auth, ...args] });
  return { auth, data, message };
}


/**
 * Relay calldata to the vault from the relayer account through a window scoped to the vault only,
 * sized for exactly one tx, then close it and verify it is closed.
 */
export async function relayToVault(vault: Address, data: Hex, relayerName = "funder") {
  const relayer = loadAccount(relayerName);
  const eoa = privateKeyToAccount(relayer.privateKey as Hex);
  const wallet = createWalletClient({ account: eoa, chain: qore, transport: http() });

  // simulate first (eth_call needs no window) so a bad command never burns a window slot
  await publicClient.call({ account: eoa.address, to: vault, data });
  const gas = ((await publicClient.estimateGas({ account: eoa.address, to: vault, data })) * 13n) / 10n;
  const gasPrice = await publicClient.getGasPrice();
  const maxFeePerGas = (gasPrice * 3n) / 2n;
  const maxPriorityFeePerGas = await publicClient.estimateMaxPriorityFeePerGas();
  const maxValue = evmWindowCost({ gas, maxFeePerGas }) + 1n;

  const w0 = await evmWindow(relayer.cosmos);
  if (w0.found && w0.live) await closeWindow(relayer);
  const opened = await openWindow(relayer, { blocks: 120, maxTxs: 1, maxValue, allowedTargets: [vault] });
  try {
    const win = await evmWindow(relayer.cosmos);
    if (win.allowedTargets.map((t: string) => t.toLowerCase()).join() !== vault.toLowerCase())
      throw new Error(`window scope is ${win.allowedTargets}, expected only the vault`);
    const nonce = await publicClient.getTransactionCount({ address: eoa.address, blockTag: "pending" });
    const hash = await wallet.sendTransaction({ to: vault, data, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, value: 0n } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`vault tx reverted: ${hash}`);
    return { windowTx: opened.transactionHash, hash, gasUsed: receipt.gasUsed, window: { maxValue, scope: win.allowedTargets } };
  } finally {
    const w = await evmWindow(relayer.cosmos);
    if (w.found && w.live) await closeWindow(relayer);
    const after = await evmWindow(relayer.cosmos);
    if (after.found && after.live) throw new Error("relayer window still live!");
  }
}
