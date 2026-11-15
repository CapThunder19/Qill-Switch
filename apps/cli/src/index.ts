/**
 * qill: the owner CLI. All power-granting commands are ML-DSA-87 signed by the owner key (never in the repo)
 * and relayed through a window scoped to the vault only.
 *
 *   qill status
 *   qill mandate compile "<plain English>" [--llm]       → prints text and compiled rules side by side, writes mandates/<id>.json
 *   qill mandate submit mandates/<id>.json [--yes]        → owner-signs createMandate, relays it, sets smart-account rules
 *   qill mandate revoke <id>
 *   qill stop | resume
 *   qill qday --fleet <name>        Q-Day button: freeze every vault, revoke every linked key, close every window, verify
 *   qill fleet status --fleet <name>
 *   qill rules show | qill rules set mandates/<id>.json
 *   qill window status | qill window close | qill panic
 *
 * Global flags: --deployment <name> (default: demo), --relayer <account> (default: relayer)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatUnits, type Address, type Hex } from "viem";
import {
  REPO_ROOT, accountExists, loadAccount, accountAddresses, evmWindow, closeWindow, getBalance,
  publicClient as pub, VAULT_ABI, relayToVault, signOwnerCommand, readRules, readAuthenticators, setRules,
  loadFleet, snapshot, qDay,
  type MandateParams,
} from "@qill/chain";
import {
  compileFromText, compileWithLlm, llmAvailable, universeFromDeployment, verifyCompiled, canonicalJson,
  MandateRejected, type CompiledMandate,
} from "@qill/mandate";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function bool(name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}
const DEPLOYMENT = flag("--deployment") ?? "demo";
const RELAYER = flag("--relayer") ?? "relayer";
const USE_LLM = bool("--llm");
const FLEET = flag("--fleet");
const YES = bool("--yes");

function deployment() {
  const f = join(REPO_ROOT, "deployments", `${DEPLOYMENT}.json`);
  if (!existsSync(f)) throw new Error(`no deployment record ${f}`);
  return JSON.parse(readFileSync(f, "utf8")) as { contracts: Record<string, Address>; executor?: Address };
}
const vaultAddr = () => deployment().contracts.QillVault as Address;
const read = (fn: string, args: unknown[] = []) => pub.readContract({ address: vaultAddr(), abi: VAULT_ABI, functionName: fn, args });
const smartAccountName = () => (DEPLOYMENT === "demo" ? "agentacct" : undefined);

// ------------------------------------------------------------------ mandate files

const MANDATE_DIR = join(REPO_ROOT, "mandates");
function saveMandate(c: CompiledMandate): string {
  mkdirSync(MANDATE_DIR, { recursive: true });
  const f = join(MANDATE_DIR, `${c.vaultParams.id}.json`);
  writeFileSync(f, JSON.stringify(JSON.parse(canonicalJson({ deployment: DEPLOYMENT, ...c })), null, 2));
  return f;
}
function loadMandate(path: string): CompiledMandate & { deployment: string } {
  // pnpm --filter runs us inside apps/cli; resolve user paths against where the command was typed
  const j = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), path), "utf8"));
  const big = (a: string[]) => a.map((x) => BigInt(x));
  const vp = j.vaultParams;
  j.vaultParams = { ...vp, expiry: BigInt(vp.expiry), perTradeCap: big(vp.perTradeCap), dailyCap: big(vp.dailyCap), softLimit: big(vp.softLimit) } as MandateParams;
  return j;
}

function sideBySide(c: CompiledMandate) {
  const U = universeFromDeployment(DEPLOYMENT);
  const sym = (a: string) => Object.entries(U.tokens).find(([, t]) => t.address.toLowerCase() === a.toLowerCase())?.[0] ?? a;
  const p = c.vaultParams;
  const left = [`OWNER TEXT (${c.source})`, ...wrap(c.text, 46)];
  const right = [
    "COMPILED RULES",
    `template     ${c.draft.template}${c.draft.schedule ? `, ${c.draft.schedule}` : ""}`,
    `tokens       ${p.tokens.map(sym).join(", ")}`,
    `pools        ${p.pools.join(", ")}`,
    `per trade    ${p.perTradeCap.map((v) => formatUnits(v, 18)).join(" / ")}`,
    `per UTC day  ${p.dailyCap.map((v) => formatUnits(v, 18)).join(" / ")}`,
    `guardian >   ${p.softLimit.map((v) => formatUnits(v, 18)).join(" / ")}`,
    `expires      ${new Date(Number(p.expiry) * 1000).toISOString()}`,
    `smart acct   evm only → ${c.allowedEvmCalls.join(", ")}`,
    `             native ≤ ${c.aaRules[0]!.perTxLimit} uqor/exec, ${c.aaRules[0]!.dailyLimit} uqor/day`,
    `textHash     ${c.textHash}`,
    `rulesHash    ${c.rulesHash}`,
    `mandate id   ${p.id}`,
  ];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) console.log(`${(left[i] ?? "").padEnd(48)}│ ${right[i] ?? ""}`);
}
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    if ((line + " " + word).trim().length > w) { out.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}
async function confirm(q: string) {
  if (YES) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(a.trim())) throw new Error("aborted");
}

// ------------------------------------------------------------------ commands

async function ownerCmd(cmd: "pause" | "resume" | "qDay" | "revokeMandate" | "createMandate", args: unknown[] = []) {
  const vault = vaultAddr();
  const { data, auth } = await signOwnerCommand(vault, cmd, args);
  console.log(`signed ${cmd} for ${vault}: nonce ${auth.nonce}, ML-DSA-87 sig ${(auth.signature.length - 2) / 2} bytes`);
  const r = await relayToVault(vault, data, RELAYER);
  console.log(`relayed tx ${r.hash} (gas ${r.gasUsed}); window scoped to ${r.window.scope.join(",")}, closed`);
  return r;
}

async function status() {
  const v = vaultAddr();
  console.log(`deployment ${DEPLOYMENT} | vault ${v}`);
  console.log(`  paused ${await read("paused")}  qDayFrozen ${await read("qDayFrozen")}  executor ${await read("executor")}  ownerNonce ${await read("ownerNonce")}  guardianNonce ${await read("guardianNonce")}`);
  const n = Number(await read("mandateCount"));
  for (let i = 0; i < n; i++) {
    const id = (await read("mandateIds", [BigInt(i)])) as Hex;
    const m = (await read("getMandate", [id])) as any[];
    console.log(`  mandate ${id} status ${["None", "Active", "Revoked"][Number(m[3])]} expires ${new Date(Number(m[2]) * 1000).toISOString()}`);
  }
  for (const name of [RELAYER, smartAccountName()].filter((x): x is string => !!x && accountExists(x))) {
    const a = accountAddresses(name);
    const w = await evmWindow(a.cosmos);
    console.log(`  [${name}] ${a.cosmos} balance ${Number(await getBalance(a.cosmos)) / 1e6} QOR, window live=${w.live}`);
  }
  const sa = smartAccountName();
  if (sa && accountExists(sa)) {
    const auths = (await readAuthenticators(accountAddresses(sa).cosmos)) as any[];
    for (const k of auths) console.log(`  [${sa}] linked key 0x${k.pubkeyHex} perms ${k.permissions} revoked ${k.revoked} expires ${new Date(Number(k.expiryUnix) * 1000).toISOString()}`);
  }
}

async function main() {
  const [a, b, c] = argv;
  switch (`${a ?? ""} ${b ?? ""}`.trim()) {
    case "status": return status();
    case "mandate compile": {
      if (!b || !c) throw new Error('usage: qill mandate compile "<text>" [--llm]');
      const U = universeFromDeployment(DEPLOYMENT);
      if (USE_LLM && !llmAvailable()) throw new Error("--llm needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)");
      const compiled = USE_LLM ? await compileWithLlm(c, U) : compileFromText(c, U);
      sideBySide(compiled);
      console.log(`\nwrote ${saveMandate(compiled)}\nnext: qill mandate submit <file>`);
      return;
    }
    case "mandate submit": {
      if (!c) throw new Error("usage: qill mandate submit mandates/<id>.json");
      const m = loadMandate(c);
      if (m.deployment !== DEPLOYMENT) throw new Error(`mandate was compiled for ${m.deployment}, not ${DEPLOYMENT}`);
      verifyCompiled(m);
      sideBySide(m);
      await confirm("\nSign this mandate with the owner ML-DSA-87 key and submit?");
      await ownerCmd("createMandate", [m.vaultParams]);
      const sa = smartAccountName();
      if (sa) {
        const r = await setRules(loadAccount(sa), m.aaRules);
        console.log(`smart-account rules set (full replace, read back and matched): tx ${r.txHash}`);
      }
      return;
    }
    case "mandate revoke": {
      if (!c) throw new Error("usage: qill mandate revoke <id>");
      await ownerCmd("revokeMandate", [c]);
      return;
    }
    case "stop": return void (await ownerCmd("pause"));
    case "resume": return void (await ownerCmd("resume"));
    case "qday": {
      if (!FLEET) throw new Error("usage: qill qday --fleet <name>   (fleet/<name>.json; no default on purpose)");
      const fleet = loadFleet(FLEET);
      console.log(`Q-DAY on fleet "${FLEET}":`);
      for (const s of await snapshot(fleet)) console.log(`  ${s.kind.padEnd(6)} ${s.id.padEnd(70)} ${s.done ? "already done" : "will be " + { vault: "frozen", key: "revoked", window: "closed" }[s.kind]}`);
      await confirm("Freeze every vault FOREVER, revoke every linked key and close every window?");
      const r = await qDay(fleet);
      console.log(`\nfinal state (round ${r.round}):`);
      for (const s of r.states) console.log(`  ${s.done ? "✔" : "✘"} ${s.kind.padEnd(6)} ${s.id.padEnd(70)} ${s.detail}`);
      if (!r.ok) { process.exitCode = 1; console.log("Q-DAY INCOMPLETE: re-run qill qday to retry"); }
      return;
    }
    case "fleet status": {
      if (!FLEET) throw new Error("usage: qill fleet status --fleet <name>");
      for (const s of await snapshot(loadFleet(FLEET))) console.log(`  ${s.done ? "✔" : "·"} ${s.kind.padEnd(6)} ${s.id.padEnd(70)} ${s.detail}`);
      return;
    }
    case "rules show": {
      const sa = smartAccountName();
      if (!sa) throw new Error("no smart account for this deployment");
      const addr = accountAddresses(sa).cosmos;
      console.log(JSON.stringify({ rules: await readRules(addr), authenticators: await readAuthenticators(addr) },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return;
    }
    case "rules set": {
      const sa = smartAccountName();
      if (!sa || !c) throw new Error("usage: qill rules set mandates/<id>.json");
      const m = loadMandate(c);
      verifyCompiled(m);
      const r = await setRules(loadAccount(sa), m.aaRules);
      console.log(`rules set: tx ${r.txHash}`);
      return;
    }
    case "window status": {
      for (const n of ["drill", "funder", "relayer", "agentacct"].filter(accountExists)) {
        const w = await evmWindow(accountAddresses(n).cosmos);
        console.log(`${n.padEnd(10)} found=${w.found} live=${w.live} remainingTxs=${w.remainingTxs} scope=${w.allowedTargets.join(",") || "-"}`);
      }
      return;
    }
    case "window close":
    case "panic": {
      for (const n of ["drill", "funder", "relayer", "agentacct"].filter(accountExists)) {
        const r = await closeWindow(loadAccount(n));
        console.log(`${n.padEnd(10)} ${r.txHash ? `closed in ${r.txHash}` : "no window"}`);
      }
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  }
}

main().catch((e) => {
  console.error(e instanceof MandateRejected ? e.message : `error: ${e.message}`);
  process.exitCode = 1;
});
