/**
 * Dashboard API: a local signer service. Binds 127.0.0.1 only. Reads chain state for the UI and performs owner
 * actions (STOP / RESUME / Q-Day) by signing with the owner ML-DSA-87 key IN THIS PROCESS: the key never reaches the
 * browser. Every POST needs the session token printed at startup (header x-qill-token), so another local page cannot
 * trigger an action.
 *
 *   pnpm dashboard:api        (port DASHBOARD_API_PORT, default 8788; serves ../dist when built)
 */
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { formatUnits, keccak256, toHex, type Address, type Hex } from "viem";
import {
  REPO_ROOT, accountAddresses, accountExists, evmWindow, getBalance, publicClient as pub, VAULT_ABI,
  readRules, readAuthenticators, signOwnerCommand, relayToVault, loadFleet, snapshot, qDay,
} from "@qill/chain";

const PORT = Number(process.env.DASHBOARD_API_PORT ?? 8788);
const TOKEN = process.env.QILL_DASHBOARD_TOKEN ?? randomBytes(16).toString("hex");
const DIST = join(REPO_ROOT, "apps/dashboard/dist");
const SYM: Record<string, string> = {};
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function deployment(name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("bad deployment");
  const d = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", `${name}.json`), "utf8"));
  SYM[d.contracts.TokenA.toLowerCase()] = "QTA";
  SYM[d.contracts.TokenB.toLowerCase()] = "QTB";
  return d;
}
function tail(file: string, n: number): any[] {
  const f = join(REPO_ROOT, "logs", file);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
}

async function state(name: string) {
  const d = deployment(name);
  const vault = d.contracts.QillVault as Address;
  const r = (fn: string, a: unknown[] = []) => pub.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args: a });
  const [paused, qDayFrozen, executor, ownerNonce, guardianNonce, count] = await Promise.all(
    ["paused", "qDayFrozen", "executor", "ownerNonce", "guardianNonce", "mandateCount"].map((f) => r(f)));
  const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const balances: Record<string, string> = {};
  for (const t of [d.contracts.TokenA, d.contracts.TokenB]) balances[SYM[t.toLowerCase()]!] = formatUnits((await pub.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [vault] })) as bigint, 18);

  const mandates = [];
  const today = BigInt(Math.floor(Date.now() / 86_400_000));
  for (let i = Number(count) - 1; i >= 0; i--) {
    const id = (await r("mandateIds", [BigInt(i)])) as Hex;
    const [textHash, rulesHash, expiry, status, pools, tokens] = (await r("getMandate", [id])) as [Hex, Hex, bigint, number, Address[], Address[]];
    const limits = [];
    for (const t of tokens) {
      const [perTradeCap, dailyCap, softLimit, spentToday, dayIndex] = (await r("limits", [id, t])) as bigint[];
      limits.push({ token: SYM[t.toLowerCase()] ?? t, perTradeCap: formatUnits(perTradeCap!, 18), dailyCap: formatUnits(dailyCap!, 18),
        softLimit: formatUnits(softLimit!, 18), spentToday: formatUnits(dayIndex === today ? spentToday! : 0n, 18) });
    }
    const f = join(REPO_ROOT, "mandates", `${id}.json`);
    const file = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
    mandates.push({
      id, status: ["None", "Active", "Revoked"][Number(status)], expiry: Number(expiry), pools, tokens: tokens.map((t) => SYM[t.toLowerCase()] ?? t),
      textHash, rulesHash, limits, text: file?.text, draft: file?.draft, allowedEvmCalls: file?.allowedEvmCalls,
      hashesMatch: file ? keccak256(toHex(file.text)) === textHash && keccak256(toHex(file.rulesJson)) === rulesHash : null,
    });
  }

  const accounts = [];
  for (const n of ["drill", "funder", "relayer", "agentacct"].filter(accountExists)) {
    const a = accountAddresses(n);
    const w = await evmWindow(a.cosmos);
    accounts.push({ name: n, cosmos: a.cosmos, evm: a.evm, balanceQor: Number(await getBalance(a.cosmos)) / 1e6, windowLive: w.live, windowFound: w.found });
  }
  let smartAccount;
  if (accountExists("agentacct")) {
    const a = accountAddresses("agentacct");
    smartAccount = { address: a.evm, rules: await readRules(a.cosmos), keys: await readAuthenticators(a.cosmos) };
  }
  return { deployment: name, vault, paused, qDayFrozen, executor, ownerNonce, guardianNonce, balances, mandates, accounts, smartAccount, ts: Date.now() };
}

async function ownerAction(name: string, cmd: "pause" | "resume") {
  const vault = deployment(name).contracts.QillVault as Address;
  const { data, auth } = await signOwnerCommand(vault, cmd, []);
  const r = await relayToVault(vault, data, "relayer");
  return { cmd, vault, nonce: auth.nonce, tx: r.hash, gasUsed: r.gasUsed, windowScope: r.window.scope };
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, big));
}
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "GET") {
        const dep = url.searchParams.get("deployment") ?? "demo";
        if (url.pathname === "/api/state") return json(res, 200, await state(dep));
        if (url.pathname === "/api/activity") return json(res, 200, { agent: tail("agent.jsonl", 60).reverse(), guardian: tail("guardian.jsonl", 30).reverse() });
        if (url.pathname === "/api/attacks") return json(res, 200, { runs: tail("attacks.jsonl", 10).reverse() });
        if (url.pathname === "/api/fleet") return json(res, 200, { fleet: url.searchParams.get("fleet"), items: await snapshot(loadFleet(url.searchParams.get("fleet") ?? "production")) });
        return json(res, 404, { error: "not found" });
      }
      if (req.method === "POST") {
        if (req.headers["x-qill-token"] !== TOKEN) return json(res, 403, { error: "missing or wrong x-qill-token (printed by the API at startup)" });
        let raw = "";
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : {};
        if (url.pathname === "/api/stop") return json(res, 200, await ownerAction(body.deployment ?? "demo", "pause"));
        if (url.pathname === "/api/resume") return json(res, 200, await ownerAction(body.deployment ?? "demo", "resume"));
        if (url.pathname === "/api/qday") {
          if (body.confirm !== "Q-DAY") return json(res, 400, { error: "type Q-DAY to confirm" });
          if (!body.fleet) return json(res, 400, { error: "fleet required" });
          const lines: string[] = [];
          const r = await qDay(loadFleet(body.fleet), { log: (s) => lines.push(s) });
          return json(res, 200, { ...r, log: lines });
        }
        return json(res, 404, { error: "not found" });
      }
      return json(res, 405, { error: "method" });
    }
    // static UI (after `pnpm --filter @qill/dashboard build`)
    const file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname.replace(/\.\./g, ""));
    if (existsSync(file)) { res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); return res.end(readFileSync(file)); }
    res.writeHead(404).end("not found (dev UI: pnpm dashboard:dev)");
  } catch (e: any) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`qill dashboard API on http://127.0.0.1:${PORT}`);
  console.log(`session token (paste into the dashboard to enable STOP / Q-Day): ${TOKEN}`);
});
