/**
 * Disposable fleet for a REAL Q-Day test (never the drill or demo vaults):
 * account qdayacct (smart account, linked key "qday-agent", rule → qday-test vault) + deployment qday-test.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/accounts.js";
import { ensureAccount } from "../src/cosmos.js";
import { agentRule, linkAgentKey, loadOrCreateLinkKey, readAuthenticators } from "../src/aa.js";

const smart = await ensureAccount("qdayacct", 600_000n);
await ensureAccount("relayer", 5_000_000n);
const dep = join(REPO_ROOT, "deployments", "qday-test.json");
if (!existsSync(dep)) {
  const out = execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "packages/chain/scripts/deploy.ts"),
    "--deployer", "relayer", "--executor", smart.evm, "--name", "qday-test", "--execute"], { cwd: join(REPO_ROOT, "packages/chain"), encoding: "utf8" });
  console.log(out.split("\n").filter((l) => /checks|wrote|window closed/.test(l)).join("\n"));
}
const vault = JSON.parse(readFileSync(dep, "utf8")).contracts.QillVault;
const key = loadOrCreateLinkKey("qday-agent");
if (!((await readAuthenticators(smart.cosmos)) as any[]).some((k) => !k.revoked)) {
  const r = await linkAgentKey(smart, key, agentRule({ vault, perTxLimitUqor: 1_000n, dailyLimitUqor: 10_000n }), 2);
  console.log("linked qday-agent", key.address, "tx", r.txHash);
}
console.log("qday-test fleet ready: vault", vault, "smart account", smart.cosmos);
