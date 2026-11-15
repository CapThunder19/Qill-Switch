import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeErrorResult, formatEther, formatUnits,
  parseAbi, parseEther, isAddress, isHex, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VAULT_ABI } from "./vaultAbi";

type Cfg = any;
type Attempt = { ts: number; name: string; ok: boolean; detail: string };

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
]);

function reason(e: any): string {
  let c = e, m = "";
  while (c) {
    const data = typeof c.data === "string" ? c.data : c.data?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try { return `vault reverted: ${decodeErrorResult({ abi: VAULT_ABI, data: data as Hex }).errorName}`; } catch { /* not a vault error */ }
    }
    m = c.details || c.shortMessage || c.message || m;
    c = c.cause;
  }
  return String(m).replace(/^failed to broadcast transaction: /, "").replace(/; open one with MsgOpenEVMWindow.*/, "").slice(0, 220);
}

export function App() {
  const [cfg, setCfg] = useState<Cfg>();
  const [live, setLive] = useState<any>();
  const [err, setErr] = useState<string>();
  const [attempts, setAttempts] = useState<Attempt[]>(() => { try { return JSON.parse(localStorage.getItem("sta-attempts") ?? "[]"); } catch { return []; } });
  const [busy, setBusy] = useState<string>();
  const [to, setTo] = useState("");
  const [custom, setCustom] = useState({ to: "", data: "0x", value: "0" });

  useEffect(() => { fetch("./challenge.json").then((r) => r.json()).then(setCfg).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { try { localStorage.setItem("sta-attempts", JSON.stringify(attempts.slice(0, 100))); } catch { /* ignore */ } }, [attempts]);

  const chain = useMemo(() => cfg && defineChain({ id: cfg.network.evmChainId, name: cfg.network.name, nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [cfg.network.evmRpc] } } }), [cfg]);
  const pub = useMemo(() => chain && createPublicClient({ chain, transport: http() }), [chain]);
  const acct = useMemo(() => cfg && privateKeyToAccount(cfg.publishedKeys.challengeAccount.privateKey), [cfg]);
  const wallet = useMemo(() => chain && acct && createWalletClient({ account: acct, chain, transport: http() }), [chain, acct]);

  const refresh = useCallback(async () => {
    if (!cfg || !pub) return;
    try {
      const C = cfg.contracts;
      const bal = (t: Address, w: Address) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [w] });
      const v = (fn: string) => pub.readContract({ address: C.QillVault, abi: VAULT_ABI, functionName: fn as any });
      const [accWei, nonce, smartWei, vA, vB, pA, pB, paused, frozen, executor, ownerNonce, block] = await Promise.all([
        pub.getBalance({ address: cfg.publishedKeys.challengeAccount.evm }), pub.getTransactionCount({ address: cfg.publishedKeys.challengeAccount.evm }),
        pub.getBalance({ address: cfg.smartAccount.evm }), bal(C.TokenA, C.QillVault), bal(C.TokenB, C.QillVault), bal(C.TokenA, C.MockPool), bal(C.TokenB, C.MockPool),
        v("paused"), v("qDayFrozen"), v("executor"), v("ownerNonce"), pub.getBlockNumber(),
      ]);
      setLive({ accWei, nonce, smartWei, vA, vB, pA, pB, paused, frozen, executor, ownerNonce, block, at: Date.now() });
      setErr(undefined);
    } catch (e: any) { setErr(reason(e)); }
  }, [cfg, pub]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, [refresh]);

  async function attempt(name: string, fn: () => Promise<Hex | void>) {
    setBusy(name);
    try {
      const h = await fn();
      if (h && pub) {
        const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
        setAttempts((a) => [{ ts: Date.now(), name, ok: r.status === "success", detail: `${r.status.toUpperCase()} ${h}` }, ...a]);
      } else setAttempts((a) => [{ ts: Date.now(), name, ok: true, detail: "simulation passed" }, ...a]);
    } catch (e: any) {
      setAttempts((a) => [{ ts: Date.now(), name, ok: false, detail: reason(e) }, ...a]);
    }
    setBusy(undefined);
    refresh();
  }

  if (!cfg) return <div className="page"><p>{err ? `Could not load challenge.json: ${err}` : "Loading…"}</p></div>;
  const C = cfg.contracts as Record<string, Address>;
  const B = cfg.baseline;
  const me = (isAddress(to) ? to : cfg.publishedKeys.challengeAccount.evm) as Address;
  const junkAuth = { pubkey: toHex(new Uint8Array(2592).fill(7)), signature: toHex(new Uint8Array(4627).fill(9)), nonce: 0n, expiry: 2n ** 40n };
  const send = (tx: any) => wallet!.sendTransaction({ gas: 500_000n, ...tx });
  const vcall = (fn: string, args: unknown[]) => encodeFunctionData({ abi: VAULT_ABI, functionName: fn as any, args: args as any });

  const landed = live ? Number(live.nonce) - Number(B.challengeAccountNonce) : 0;
  const vaultDown = live ? (BigInt(B.vaultQTA) - live.vA > 0n || BigInt(B.vaultQTB) - live.vB > 0n) : false;
  const controlChanged = live ? live.frozen || Number(live.ownerNonce) !== B.ownerNonce || live.executor.toLowerCase() !== cfg.smartAccount.evm.toLowerCase() : false;
  const accDown = live ? BigInt(B.challengeAccountWei) - live.accWei : 0n;
  const intact = live && landed === 0 && !vaultDown && !controlChanged && accDown <= 0n;

  const attacks: [string, () => Promise<Hex | void>][] = [
    ["Send 1 QOR from the challenge account", () => send({ to: me, value: parseEther("1"), gas: 21_000n })],
    ["Token A: approve(you, max)", () => send({ to: C.TokenA, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [me, 2n ** 256n - 1n] }) })],
    ["Token A: transferFrom(vault → you)", () => send({ to: C.TokenA, data: encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args: [C.QillVault, me, 10n ** 18n] }) })],
    ["Deploy a contract", () => send({ to: null, data: "0x6080604052348015600f57600080fd5b50" })],
    ["Vault: withdraw everything (fake ML-DSA sig)", () => send({ to: C.QillVault, data: vcall("withdraw", [junkAuth, me, C.TokenA, BigInt(B.vaultQTA)]) })],
    ["Vault: setExecutor(you) (fake sig)", () => send({ to: C.QillVault, data: vcall("setExecutor", [junkAuth, me]) })],
    ["Vault: rotateOwnerKey (fake sig)", () => send({ to: C.QillVault, data: vcall("rotateOwnerKey", [junkAuth, keccak256(toHex("attacker"))]) })],
    ["Vault: trade directly (not the executor)", () => send({ to: C.QillVault, data: vcall("trade", [{ mandateId: cfg.mandate.id, pool: C.MockPool, tokenIn: C.TokenA, tokenOut: C.TokenB, amountIn: 10n ** 18n, minOut: 0n }, { pubkey: "0x", signature: "0x", nonce: 0n, expiry: 0n }]) })],
    ["Simulate: withdraw via eth_call (no window needed)", async () => { await pub!.call({ account: me, to: C.QillVault, data: vcall("withdraw", [junkAuth, me, C.TokenA, 1n]) }); }],
  ];

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Qill Switch · QoreChain testnet</p>
        <h1>Steal This Agent</h1>
        <p className="lead">Here is an AI agent's private key. And the private key of the account holding its bait. Take the money.</p>
        <p className="muted">Every power-granting action needs an ML-DSA-87 (post-quantum) signature verified on chain. A classical key, even a stolen one, can't loosen anything.</p>
      </header>

      <section className={`verdict ${intact ? "safe" : live ? "breached" : ""}`}>
        <div className="big">{!live ? "…" : intact ? "Not stolen yet" : "Something moved, see below"}</div>
        <div className="muted small">live from chain · block {live?.block?.toString() ?? "…"} · baseline {new Date(B.at).toLocaleDateString()}</div>
      </section>

      <section className="grid">
        <div className="card"><h3>Bait (challenge account)</h3><div className="num">{live ? Number(formatEther(live.accWei)).toFixed(4) : "…"} QOR</div><div className="small muted">baseline {Number(formatEther(BigInt(B.challengeAccountWei))).toFixed(4)}</div></div>
        <div className="card"><h3>Transactions the key landed</h3><div className={`num ${landed > 0 ? "bad" : ""}`}>{live ? landed : "…"}</div><div className="small muted">account nonce since launch</div></div>
        <div className="card"><h3>Vault</h3><div className="num">{live ? `${Number(formatUnits(live.vA, 18)).toLocaleString()} A · ${Number(formatUnits(live.vB, 18)).toLocaleString()} B` : "…"}</div><div className="small muted">{live ? `${live.paused ? "paused" : "live"}${live.frozen ? ", FROZEN" : ""} · owner nonce ${live.ownerNonce} (baseline ${B.ownerNonce})` : ""}</div></div>
        <div className="card"><h3>Agent smart account</h3><div className="num">{live ? Number(formatEther(live.smartWei)).toFixed(6) : "…"} QOR</div><div className="small muted">executor {live?.executor?.toLowerCase() === cfg.smartAccount.evm.toLowerCase() ? "unchanged" : "CHANGED"}</div></div>
      </section>

      <section className="card keys">
        <h2>The keys</h2>
        {Object.entries(cfg.publishedKeys).map(([k, v]: [string, any]) => (
          <div key={k} className="key">
            <div className="small muted">{v.what}</div>
            <div className="row"><code>{v.privateKey}</code><button onClick={() => navigator.clipboard?.writeText(v.privateKey)}>Copy</button></div>
            <div className="small mono muted">{v.evm ?? v.address}{v.cosmos ? ` · ${v.cosmos}` : ""}</div>
          </div>
        ))}
        <details>
          <summary>Contracts and the agent's mandate</summary>
          <ul className="small mono">{Object.entries(C).map(([k, a]) => <li key={k}>{k}: {a}</li>)}<li>smart account: {cfg.smartAccount.evm}</li></ul>
          <blockquote>{cfg.mandate.text}</blockquote>
          <p className="small muted">Mandate {cfg.mandate.id}: every trade needs the guardian's ML-DSA-87 co-signature (soft limit 0), max 10 per trade, 20 per day. The agent key may only call vault.trade and move at most 1 uqor of native QOR per day; its smart account holds 0.</p>
        </details>
      </section>

      <section className="card">
        <h2>Attack console</h2>
        <p className="small muted">Signed in your browser with the published challenge key and sent to {cfg.network.evmRpc}. Nothing is sent anywhere else.</p>
        <label className="small">Send stolen funds to <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="your 0x address (optional)" /></label>
        <div className="buttons">
          {attacks.map(([name, fn]) => <button key={name} disabled={!!busy} onClick={() => attempt(name, fn)}>{busy === name ? "…" : name}</button>)}
        </div>
        <details>
          <summary>Custom transaction</summary>
          <div className="custom">
            <input placeholder="to 0x…" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value.trim() })} />
            <input placeholder="data 0x…" value={custom.data} onChange={(e) => setCustom({ ...custom, data: e.target.value.trim() })} />
            <input placeholder="value in QOR" value={custom.value} onChange={(e) => setCustom({ ...custom, value: e.target.value.trim() })} />
            <button disabled={!!busy || !isAddress(custom.to) || !isHex(custom.data)} onClick={() => attempt(`custom tx → ${custom.to.slice(0, 10)}…`, () => send({ to: custom.to as Address, data: custom.data as Hex, value: parseEther(custom.value || "0") }))}>Send</button>
          </div>
        </details>
        <ul className="attempts">
          {attempts.map((a) => <li key={a.ts}><span className={`pill ${a.ok ? "bad" : "ok"}`}>{a.ok ? "LANDED" : "blocked"}</span> <b>{a.name}</b><div className="small muted">{a.detail}</div></li>)}
          {attempts.length === 0 && <li className="muted small">Your attempts appear here (kept in this browser only).</li>}
        </ul>
      </section>

      <section className="card">
        <h2>Beyond the browser</h2>
        <p className="small">The browser can only use the EVM lane (QoreChain's public REST and RPC don't allow cross-origin calls). The full attack bot also tries the Cosmos lane with the classical key (bank send, opening an EVM window, re-registering the PQC key, EIP-7702 consent) and every agent-key attack through <code>MsgExecuteEVM</code>:</p>
        <pre>git clone https://github.com/CapThunder19/Qill-Switch && cd Qill-Switch{"\n"}pnpm install && pnpm attack --target challenge   # see apps/attack-bot</pre>
        <p className="small muted">Our own run: 39 attempts, 0 successes (<a href="https://github.com/CapThunder19/Qill-Switch/blob/main/docs/challenge-attack-run-1.txt">log</a>).</p>
      </section>

      <footer className="small muted">Testnet only. These keys were generated for this challenge and control nothing else. <a href="https://github.com/CapThunder19/Qill-Switch">Source</a></footer>
    </div>
  );
}
