/** Re-apply the agent rule with the minimum native limits (1 uqor per execution / per day) on a smart account. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadAccount } from "../src/accounts.js";
import { agentRule, setRules } from "../src/aa.js";
const [account = "agentacct", deployment = "demo"] = process.argv.slice(2);
const vault = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${deployment}.json`), "utf8")).contracts.QillVault;
const r = await setRules(loadAccount(account), [agentRule({ vault, perTxLimitUqor: 1n, dailyLimitUqor: 1n })]);
console.log(`${account}: rules replaced + read back`, r.txHash, JSON.stringify(r.rules, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
