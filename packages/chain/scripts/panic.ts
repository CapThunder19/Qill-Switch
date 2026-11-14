/**
 * PANIC: close every EVM window on every account we control, then re-query and show final state.
 * Retries anything not closed. Safe to run any time (an account without a window is a no-op).
 */
import { accountExists, loadAccount } from "../src/accounts.js";
import { closeWindow, evmWindow } from "../src/cosmos.js";
import { deployment, publicClient, VAULT_ABI } from "../src/vault.js";

const names = ["drill", "funder", "agent", "relayer", "challenge"].filter(accountExists);
let failed = false;
for (const n of names) {
  const a = loadAccount(n);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await closeWindow(a);
      const w = await evmWindow(a.cosmos);
      console.log(`[${n}] window live=${w.live}${r.txHash ? ` (closed in ${r.txHash})` : " (none open)"}`);
      break;
    } catch (e: any) {
      console.log(`[${n}] attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) failed = true;
    }
  }
}
try {
  const v = deployment().contracts.QillVault;
  const r = (fn: string) => publicClient.readContract({ address: v, abi: VAULT_ABI, functionName: fn });
  console.log(`[vault ${v}] paused=${await r("paused")} qDayFrozen=${await r("qDayFrozen")} executor=${await r("executor")}`);
} catch (e: any) { console.log("vault read failed:", e.message); }
process.exitCode = failed ? 1 : 0;
