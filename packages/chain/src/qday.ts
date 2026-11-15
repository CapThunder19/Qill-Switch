/**
 * The Q-Day button. For every item in a fleet:
 *   1. owner-signed qDay() on every vault (freeze trading forever, pause, drop the executor)
 *   2. revoke-authenticator for every linked key on every smart account
 *   3. close-evm-window on every account we control
 *   4. re-query every item, show its final state, and retry anything not done (up to `rounds`)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, type Address } from "viem";
import { revokeAuthenticatorMsg } from "@qorechain/sdk";
import { REPO_ROOT, accountExists, loadAccount } from "./accounts.js";
import { closeWindow, evmWindow, sendMsgs } from "./cosmos.js";
import { publicClient as pub, VAULT_ABI, relayToVault, signOwnerCommand } from "./vault.js";
import { readAuthenticators } from "./aa.js";

export interface Fleet {
  /** deployment record names (deployments/<name>.json) */
  vaults: string[];
  /** chain accounts whose linked keys are revoked */
  smartAccounts: string[];
  /** every account whose EVM window must be closed */
  windowAccounts: string[];
  /** account that relays the owner-signed qDay() calls */
  relayer: string;
}

export function loadFleet(name: string): Fleet {
  const f = join(REPO_ROOT, "fleet", `${name}.json`);
  if (!existsSync(f)) throw new Error(`no fleet file ${f}`);
  return JSON.parse(readFileSync(f, "utf8"));
}

export interface ItemState { kind: "vault" | "key" | "window"; id: string; done: boolean; detail: string }

async function vaultState(name: string): Promise<ItemState & { address: Address }> {
  const address = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${name}.json`), "utf8")).contracts.QillVault as Address;
  const r = (fn: string) => pub.readContract({ address, abi: VAULT_ABI, functionName: fn });
  const [frozen, paused, executor] = await Promise.all([r("qDayFrozen"), r("paused"), r("executor")]);
  const done = frozen === true && paused === true && /^0x0{40}$/i.test(executor as string);
  return { kind: "vault", id: `${name} ${address}`, address, done, detail: `qDayFrozen=${frozen} paused=${paused} executor=${executor}` };
}

async function keyStates(account: string): Promise<ItemState[]> {
  const a = loadAccount(account);
  const auths = (await readAuthenticators(a.cosmos)) as any[];
  return auths.map((k) => ({ kind: "key" as const, id: `${account} ${k.scheme}:0x${k.pubkeyHex}`, done: k.revoked === true, detail: `revoked=${k.revoked} perms=${k.permissions}` }));
}

async function windowState(account: string): Promise<ItemState> {
  const w = await evmWindow(loadAccount(account).cosmos);
  return { kind: "window", id: account, done: !w.live, detail: `found=${w.found} live=${w.live}` };
}

export async function snapshot(fleet: Fleet): Promise<ItemState[]> {
  const out: ItemState[] = [];
  for (const v of fleet.vaults) out.push(await vaultState(v));
  for (const s of fleet.smartAccounts.filter(accountExists)) out.push(...(await keyStates(s)));
  for (const w of fleet.windowAccounts.filter(accountExists)) out.push(await windowState(w));
  return out;
}

export async function qDay(fleet: Fleet, opts: { rounds?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const rounds = opts.rounds ?? 3;
  for (let round = 1; round <= rounds; round++) {
    log(`— round ${round}`);
    // 1. vaults
    for (const v of fleet.vaults) {
      const s = await vaultState(v);
      if (s.done) continue;
      try {
        const { data } = await signOwnerCommand(s.address, "qDay", []);
        const r = await relayToVault(s.address, data, fleet.relayer);
        log(`  vault ${v}: qDay() tx ${r.hash}`);
      } catch (e: any) { log(`  vault ${v}: FAILED ${e.message}`); }
    }
    // 2. linked keys
    for (const acct of fleet.smartAccounts.filter(accountExists)) {
      const a = loadAccount(acct);
      for (const k of ((await readAuthenticators(a.cosmos)) as any[]).filter((k) => !k.revoked)) {
        try {
          const msg = revokeAuthenticatorMsg({ owner: a.cosmos, scheme: k.scheme, pubkey: hexToBytes(`0x${k.pubkeyHex}`) });
          const r = await sendMsgs(a, [msg], { gas: 500_000 });
          log(`  key ${acct} 0x${k.pubkeyHex}: revoked tx ${r.transactionHash}`);
        } catch (e: any) { log(`  key ${acct} 0x${k.pubkeyHex}: FAILED ${e.message}`); }
      }
    }
    // 3. windows (after step 1, which opens and closes relayer windows)
    for (const w of fleet.windowAccounts.filter(accountExists)) {
      try {
        const r = await closeWindow(loadAccount(w));
        if (r.txHash) log(`  window ${w}: closed tx ${r.txHash}`);
      } catch (e: any) { log(`  window ${w}: FAILED ${e.message}`); }
    }
    // 4. re-query
    const states = await snapshot(fleet);
    if (states.every((s) => s.done)) return { ok: true, round, states };
    log(`  not done yet: ${states.filter((s) => !s.done).map((s) => s.id).join(", ")}`);
  }
  const states = await snapshot(fleet);
  return { ok: states.every((s) => s.done), round: rounds, states };
}
