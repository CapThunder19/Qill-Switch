/** Print chain status for our accounts: existence, balance, PQC key, EVM window. Public info only. */
import { accountAddresses, accountExists } from "../src/accounts.js";
import { getAccountInfo, getBalance, pqcStatus, evmWindow, evmLimits, NET } from "../src/cosmos.js";

const names = process.argv.slice(2).length ? process.argv.slice(2) : ["funder", "drill"];
console.log("network", NET.chainId, NET.rest);
try { console.log("evm_limits", JSON.stringify(await evmLimits())); } catch (e: any) { console.log("evm_limits ERR", e.message); }
try {
  const r = await fetch(NET.rest + "/qorechain/abstractaccount/v1/config");
  console.log("abstractaccount config", r.status, (await r.text()).slice(0, 300));
} catch (e: any) { console.log("aa config ERR", e.message); }
for (const n of names) {
  if (!accountExists(n)) { console.log(n, "no local key"); continue; }
  const a = accountAddresses(n);
  const [info, bal, pqc, win] = await Promise.all([
    getAccountInfo(a.cosmos), getBalance(a.cosmos), pqcStatus(a.cosmos).catch((e) => ({ error: e.message })), evmWindow(a.cosmos).catch((e) => ({ error: e.message })),
  ]);
  console.log(`\n[${n}] ${a.cosmos} / ${a.evm}`);
  console.log("  on chain:", info ? `account #${info.accountNumber} seq ${info.sequence}` : "no (never funded)");
  console.log("  balance:", Number(bal) / 1e6, "QOR");
  console.log("  pqc:", "registered" in pqc ? `registered=${pqc.registered}` : pqc);
  console.log("  evm window:", JSON.stringify(win, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
