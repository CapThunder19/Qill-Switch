import { Fragment, useCallback, useEffect, useState } from "react";

/* The browser only ever reads state and asks the LOCAL API to act. No key material is in this bundle. */

type Any = any;
const short = (s?: string, n = 6) => (s ? `${s.slice(0, n + 2)}…${s.slice(-4)}` : "–");
const fmt = (v?: string | number) => (v === undefined ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 }));
const ago = (ts: string) => {
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

async function get(path: string) {
  const r = await fetch(path);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

export function App() {
  const [deployment, setDeployment] = useState("demo");
  const [state, setState] = useState<Any>();
  const [activity, setActivity] = useState<Any>({ agent: [], guardian: [] });
  const [attacks, setAttacks] = useState<Any>({ runs: [] });
  const [error, setError] = useState<string>();
  const [token, setToken] = useState(() => sessionStorage.getItem("qill-token") ?? "");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [s, a, k] = await Promise.all([get(`/api/state?deployment=${deployment}`), get("/api/activity"), get("/api/attacks")]);
      setState(s); setActivity(a); setAttacks(k); setError(undefined);
    } catch (e: Any) { setError(e.message); }
  }, [deployment]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { try { sessionStorage.setItem("qill-token", token); } catch { /* storage may be unavailable */ } }, [token]);

  async function act(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label); setNotice(undefined);
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-qill-token": token }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setNotice(`${label} done${j.tx ? `: tx ${short(j.tx, 8)}` : j.ok !== undefined ? `: ${j.ok ? "every item frozen / revoked / closed" : "INCOMPLETE, run again"}` : ""}`);
      await refresh();
    } catch (e: Any) { setNotice(`${label} failed: ${e.message}`); }
    setBusy(undefined);
  }
  function qday() {
    const fleet = prompt('Q-DAY freezes every vault in the fleet FOREVER, revokes every agent key and closes every window.\nFleet name (fleet/<name>.json):', "qday-test");
    if (!fleet) return;
    const confirm = prompt(`Type Q-DAY to run it on fleet "${fleet}".`);
    if (confirm !== "Q-DAY") return;
    act("/api/qday", { fleet, confirm }, `Q-Day on ${fleet}`);
  }

  const active = state?.mandates?.find((m: Any) => m.status === "Active" && m.expiry * 1000 > Date.now());
  const status = !state ? "loading" : state.qDayFrozen ? "frozen" : state.paused ? "stopped" : "live";

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>◆</span>
          <div>
            <h1>Qill Switch</h1>
            <p className="sub">Quantum-signed mandates for AI agents · QoreChain testnet</p>
          </div>
        </div>
        <div className="controls">
          <select value={deployment} onChange={(e) => setDeployment(e.target.value)} aria-label="deployment">
            <option value="demo">demo vault</option>
            <option value="qorechain-diana">drill vault</option>
            <option value="qday-test">qday-test vault</option>
          </select>
          <input className="token" type="password" placeholder="API session token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="session token" />
          <button className="btn stop" disabled={!token || !!busy || status !== "live"} onClick={() => act("/api/stop", { deployment }, "STOP")}>STOP</button>
          <button className="btn ghost" disabled={!token || !!busy || status !== "stopped"} onClick={() => act("/api/resume", { deployment }, "Resume")}>Resume</button>
          <button className="btn qday" disabled={!token || !!busy} onClick={qday}>Q-DAY</button>
        </div>
      </header>

      {error && <div className="banner bad">API: {error}. Start it with <code>pnpm dashboard:api</code>.</div>}
      {busy && <div className="banner">{busy}: signing with the owner ML-DSA-87 key in the local API and relaying through a vault-scoped window…</div>}
      {notice && <div className="banner">{notice}</div>}

      <section className="grid">
        <div className="card owner">
          <h2>Vault</h2>
          <div className={`status ${status}`}>{status.toUpperCase()}</div>
          <dl>
            <dt>address</dt><dd className="mono">{short(state?.vault, 10)}</dd>
            <dt>executor</dt><dd className="mono">{short(state?.executor, 10)}</dd>
            <dt>owner nonce</dt><dd>{state?.ownerNonce ?? "–"}</dd>
            <dt>guardian nonce</dt><dd>{state?.guardianNonce ?? "–"}</dd>
            {state && Object.entries(state.balances).map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{fmt(v as string)}</dd></Fragment>))}
          </dl>
        </div>

        <div className="card owner">
          <h2>Smart account</h2>
          <p className="mono small">{short(state?.smartAccount?.address, 10)}</p>
          {(state?.smartAccount?.rules?.rules ?? []).map((r: Any) => (
            <div key={r.id} className="rule">
              <div><b>{r.id}</b> <span className={`pill ${r.enabled ? "ok" : "bad"}`}>{r.enabled ? "enabled" : "DISABLED"}</span></div>
              <div className="small">native ≤ {r.perTxLimit} uqor / exec, {r.dailyLimit} / day · denoms {r.allowedDenoms.join(", ") || "any"}</div>
              <div className="small mono">calls: {r.allowedEvmCalls.join(", ")}</div>
            </div>
          ))}
          {(state?.smartAccount?.keys ?? []).map((k: Any) => (
            <div key={k.pubkeyHex} className="small">
              agent key <span className="mono">0x{k.pubkeyHex.slice(0, 8)}…</span> · {k.permissions.join(",")} ·{" "}
              <span className={`pill ${k.revoked ? "bad" : "ok"}`}>{k.revoked ? "revoked" : "linked"}</span>
            </div>
          ))}
        </div>

        <div className="card owner">
          <h2>Accounts &amp; windows</h2>
          <table>
            <tbody>
              {(state?.accounts ?? []).map((a: Any) => (
                <tr key={a.name}><td>{a.name}</td><td>{fmt(a.balanceQor)} QOR</td><td><span className={`pill ${a.windowLive ? "warn" : "ok"}`}>{a.windowLive ? "window OPEN" : "no window"}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card owner wide">
        <h2>Active mandate {active && <span className="mono small">{short(active.id, 10)}</span>}</h2>
        {!active ? <p className="muted">No active mandate on this vault.</p> : (
          <>
            <div className="split">
              <div>
                <h3>Owner's words</h3>
                <blockquote>{active.text ?? "(text not available locally)"}</blockquote>
                <p className="small mono">textHash {short(active.textHash, 10)}</p>
              </div>
              <div>
                <h3>Compiled rules</h3>
                <dl>
                  <dt>template</dt><dd>{active.draft?.template}{active.draft?.schedule ? `, ${active.draft.schedule}` : ""}</dd>
                  <dt>tokens</dt><dd>{active.tokens.join(", ")}</dd>
                  <dt>expires</dt><dd>{new Date(active.expiry * 1000).toLocaleString()}</dd>
                  <dt>agent may call</dt><dd className="mono small">{active.allowedEvmCalls?.join(", ")}</dd>
                </dl>
                <p className="small mono">rulesHash {short(active.rulesHash, 10)} · <span className={`pill ${active.hashesMatch ? "ok" : "bad"}`}>{active.hashesMatch ? "matches chain" : "MISMATCH"}</span></p>
              </div>
            </div>
            <h3>Spend vs caps (today, UTC)</h3>
            {active.limits.map((l: Any) => {
              const pct = Math.min(100, (Number(l.spentToday) / Number(l.dailyCap)) * 100);
              return (
                <div key={l.token} className="meter">
                  <div className="meter-label"><b>{l.token}</b> <span>{fmt(l.spentToday)} / {fmt(l.dailyCap)} per day · ≤ {fmt(l.perTradeCap)} per trade · guardian above {fmt(l.softLimit)}</span></div>
                  <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </>
        )}
      </section>

      <section className="grid two">
        <div className="card owner">
          <h2>Agent activity</h2>
          <ul className="log">
            {activity.agent.slice(0, 25).map((e: Any, i: number) => (
              <li key={i} className={`ev ${e.event.replace(/\s.*/, "")}`}>
                <div className="ev-head"><b>{e.event}</b> <span className="muted">{ago(e.ts)}</span> {e.mandateId && <span className="mono small">mandate {short(e.mandateId)}</span>}</div>
                {e.event === "trade" && <div>{fmt(Number(e.amountIn) / 1e18)} {e.tokenIn} → {fmt(Number(e.amountOut) / 1e18)} {e.tokenOut} {e.guardianUsed && <span className="pill ok">guardian co-signed</span>} <span className="mono small">{short(e.txHash, 8)}</span></div>}
                {e.event === "guardian veto" && <div className="vetoed">guardian vetoed {fmt(Number(e.amountIn) / 1e18)} {e.tokenIn}: {e.reasons?.join("; ")}</div>}
                {(e.why || e.reason) && <div className="small muted">{e.why ?? e.reason}</div>}
                {e.reasoning && <div className="small">“{e.reasoning}”</div>}
                {e.error && <div className="small vetoed">{e.error}</div>}
              </li>
            ))}
            {activity.agent.length === 0 && <li className="muted">No agent activity yet. Run <code>pnpm agent --once</code>.</li>}
          </ul>
        </div>

        <div className="card attacker">
          <h2>Attack log</h2>
          {attacks.runs.length === 0 && <p className="muted">No attack runs yet. Run <code>pnpm attack</code>.</p>}
          {attacks.runs.slice(0, 3).map((r: Any) => (
            <div key={r.ts} className="run">
              <div className="ev-head"><b>{r.attempts} attempts · {r.successes} successes</b> <span className="muted">{ago(r.ts)}</span></div>
              <div className="small">value moved {Number(r.valueMovedUqor) / 1e6} QOR · vault control {r.controlChanged ? "CHANGED" : "unchanged"} · target {short(r.target)}</div>
              <ul className="log compact">
                {r.results.map((x: Any, i: number) => (
                  <li key={i}><span className={`pill ${x.outcome === "SUCCESS" ? "bad" : "blocked"}`}>{x.outcome}</span> <span className="small">[{x.lane}] {x.name}</span><div className="small muted">{x.detail}</div></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <footer className="muted small">Owner actions are signed with ML-DSA-87 by the local API and verified on chain by QoreChain's pqcVerify precompile. The browser never sees a private key.</footer>
    </div>
  );
}
