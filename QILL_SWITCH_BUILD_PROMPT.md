# Build Qill Switch — quantum-signed mandates for AI agents (QoreChain testnet)

You are building a hackathon project from an empty repo. Read this whole brief before writing code. Work in the phases below, stop at the end of each phase, show me what you built and how you tested it, and wait for my go-ahead before the next phase.

---

## 0. Context

- **Hackathon:** QoreChain "Build Before Q-Day" Developer Fest. Track: **Post-Quantum AI Agents**.
  - Rules: https://build.qorechain.io/rules · Tracks: https://build.qorechain.io/
- **Track's required features (all four must be clearly visible in code + README):**
  1. A scoped EVM window
  2. Limits on transactions, value, duration and target
  3. Smart-account spending rules
  4. Authenticated messaging
- **Hard rules:** code built during the event (repo is new), licence **MIT** with a `LICENSE` file, every library/kit/template credited in the README, public GitHub repo, README, featured image, ≤3-minute video, testnet addresses listed.
- **Deadlines (UTC):**
  - **17 Nov 23:59** — Q-Day Drill registration closes (Phase 1 must be deployed and hardened before this)
  - **18 Nov 00:00–23:59** — Q-Day Drill: a bot holds our drill account's ECDSA key and tries native transfers, opening EVM windows, EVM transfers, token approvals, and drain calls on our contracts. Ranking: proof of a working project → fewest successful attacks → most value kept.
  - **2 Dec 23:59** — final submission

## 1. What we're building (one paragraph)

**Qill Switch** lets an owner give an AI agent a *mandate* — plain-English instructions compiled into on-chain rules and signed with a quantum-safe **ML-DSA-87** key. The agent can only act inside the mandate. Anything that loosens control (new mandate, raise limit, resume, withdraw, change owner key) needs the owner's ML-DSA signature, verified on chain with QoreChain's `pqcVerify` precompile. A stolen classical ECDSA key alone can never loosen anything. Large trades also need a co-signature from an independent **guardian AI**. A **Q-Day button** revokes every classical agent key, closes every EVM window and freezes every vault with one signature. A public **"Steal This Agent"** page publishes a challenge agent's ECDSA key and lets anyone try to drain it, with a live scoreboard.

Pitch: *"QoreChain limits where your agent can go. Qill Switch limits what it may do — and stops it with one quantum-safe signature."*

## 2. Verified QoreChain facts (from the official docs — use these, don't guess)

Read these pages yourself before coding and re-check anything you rely on:
- https://docs.qorechain.io/architecture/post-quantum-security
- https://docs.qorechain.io/developer-guide/evm-development
- https://docs.qorechain.io/developer-guide/account-abstraction
- https://docs.qorechain.io/developer-guide/evm-precompiles
- https://docs.qorechain.io/developer-guide/cross-vm-interoperability
- https://docs.qorechain.io/sdk/overview

**Network (testnet)**
- Chain name `qorechain-diana`, EVM chain ID **9800**, EVM RPC `https://evm-testnet.qore.host`. Currency QOR.
- Native QOR has **6 decimals (`uqor`)**; EVM uses 18 decimals (wei). Don't mix them up.
- Max gas per EVM tx: 30,000,000 (read live from `GET /qorechain/pqc/v1/evm_limits`). Cosmos tx gas limit 50,000,000.
- Sign EVM txs with chain ID (EIP-155).

**PQC keys and hybrid signatures**
- Accounts register an ML-DSA-87 (Dilithium-5) key. CLI: `qorechaind tx pqc gen-key <name>`, then `qorechaind tx pqc register-key-v2 dilithium5 ... --pqc-key <name>` (v2 includes proof of possession — use it).
- **Register the key before the account holds any funds** — the first registration may be signed with the classical key alone.
- Chain-wide mode "Required": classical-only Cosmos-lane txs from a PQC account are rejected.
- Cosmos-lane txs are hybrid-signed: build with `--generate-only`, then `qorechaind tx pqc cosign <file> --from <key> --pqc-key <pqc-key> --chain-id qorechain-diana`, or use the QoreChain SDK / QoreX.
- Accounts used on the EVM lane must be **Ethereum-type keys (`eth_secp256k1`, coin type 60)**. The default `qor1…` coin-type-118 account cannot sign for its EVM address.

**EVM authorisation windows**
- An EVM tx is accepted only if the sender has a registered PQC key **and** a live window with room left. Otherwise `eth_sendRawTransaction` fails (codespace `pqc`, codes 26/27/28). Reads / `eth_call` / gas estimation need neither.
- Open: `qorechaind tx pqc open-evm-window <blocks> <max-txs> <max-value> --from <key> --chain-id qorechain-diana --generate-only > w.json` then `cosign`. Bounds: blocks 1–17,280; max-txs 1–1,000; max-value > 0 in uqor (native value + max fees). First bound reached closes it. Failed txs still use a slot and budget.
- Scope flags: `--native-only`, or `--allowed-targets 0xA,0xB` (limits *which* contracts, **not how much** — never list routers/forwarders/generic tokens).
- Query: `qorechaind query pqc evm-window <address>` or `GET /qorechain/pqc/v1/evm_window/{address}`. Close: `qorechaind tx pqc close-evm-window`.
- Opening a window advances the account sequence = EVM nonce → **read the nonce after the window is open**.
- Key rotation deletes the open window. EIP-7702 delegation needs `MsgAuthorizeEVMDelegation` consent — **we never grant it**.

**PQC Verify precompile (testnet only)**
- Address `0x0000000000000000000000000000000000000A01`
```solidity
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);
}
```
- pubkey 2,592 bytes, signature 4,627 bytes, message = raw bytes. Gas ≈ 25,000 + 8/byte (≈85–90k typical).
- **Always call through the typed interface** (it reverts on empty return data, which is what an inactive precompile returns). Never use a raw low-level call. Never send value to it.
- PQC Key Status precompile `0x…0A02` exists (2,500 gas) — ABI not documented; only use it if you find the ABI.
- AI precompiles `0x…0B01/0B02` are **not active** — don't use them.

**Account abstraction (`x/abstractaccount`, enabled on testnet)**
- Check first: `qorechaind query abstractaccount config` (must be `enabled: true`).
- Create: `qorechaind tx abstractaccount create session_based --from <key> ...`
- Rules: `qorechaind tx abstractaccount update-rules <account> '<json array>'` — **replaces ALL rules; omitted fields are removed**. Fields: `id`, `enabled`, `per_tx_limit`, `daily_limit` (per UTC day), `allowed_denoms`, `denom_limits`, `allowed_evm_calls` (`0x<target>` or `0x<target>/0x<selector>`).
- **`enabled: false` means NO limit. No rule means NO limit.** Our code must never produce either.
- Linked keys (authenticators): `qorechaind tx abstractaccount register-authenticator <account> <scheme> <pubkey-base64> <permissions-csv> <expiry-unix> <label>`; schemes `secp256k1` / `ed25519`; v3.2.8 requires a `possession_proof`. Revoke: `revoke-authenticator <account> <scheme> <pubkey-base64>`. Expiry ≤ 30 days.
- Permissions are fail-closed; our agent key gets **only `evm`**. Linked keys can never send key-management messages.
- Spending via a linked key: a relayer submits `MsgExecuteEVM` (or `MsgExecuteCosmos`) carrying the authenticator's signature.
- **A failed execution returns `success=false` with tx code 0** and emits `abstractaccount_execution_failed` — always check the event, never trust the code alone.
- Error codes: 5 limit exceeded, 6 authenticator expired, 9 module disabled, 10 permission denied, 11 replay.
- Every Cosmos-lane tx (including update-rules / register / revoke) needs the owner's hybrid signature.

**Unknowns — find out with a small spike, report back, never invent:**
- Exact ML-DSA-87 byte encoding QoreChain expects (does `@noble/post-quantum` `ml_dsa87` output verify with the precompile? If not, use the `qorechain-pqc` library / SDK).
- How to build, sign and submit `MsgExecuteEVM` from TypeScript (SDK or CLI).
- Whether spending rules count ERC-20 amounts inside EVM calls or only native value.
- Whether a DEX exists on testnet (otherwise deploy our mock pool).
- Testnet block time; faucet location.

## 3. Architecture

```
Owner (ML-DSA-87 key, offline)            AI agent (ECDSA linked key)        Attacker (stolen ECDSA key)
   │ signs mandates / STOP / Q-Day              │ proposes trades                       │
   ▼                                            ▼                                       ▼
Relayer (own PQC account, scoped window → vault only)   MsgExecuteEVM via smart account   rejected by chain
   │                                            │
   ▼                                            ▼
                    QoreChain testnet
   ┌─────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────┐
   │ Smart account (native)  │──▶│ QillVault (our contract)     │──▶│ Approved pool │
   │ per-tx + daily limits   │   │ pqcVerify, mandates, caps,   │   │ (mock or DEX) │
   │ agent → vault.trade only│   │ pool allowlist, pause, Q-Day │   └──────────────┘
   └─────────────────────────┘   └──────────────────────────────┘
                                        │ events
                                        ▼
                         Dashboard + Steal This Agent page
```

Core rule: **anything that grants power or moves money out requires an owner ML-DSA signature.** Tightening (pause) also requires it in the drill deployment, so the bot can't land any successful tx on our contracts.

## 4. Repo layout (pnpm monorepo, TypeScript + Foundry)

```
qill-switch/
  LICENSE (MIT)  README.md  AI_USAGE.md  THREAT_MODEL.md  .env.example  .gitignore
  contracts/            Foundry project
    src/QillVault.sol  src/interfaces/IQorePQC.sol  src/mocks/MockERC20.sol  src/mocks/MockPool.sol
    test/  script/
  packages/
    pq/                 ML-DSA-87 + ML-KEM-1024 helpers, canonical message encoding, key file handling
    chain/              EVM (viem) + Cosmos helpers: windows, AA rules, authenticators, MsgExecuteEVM, event checks
    mandate/            mandate schema, compiler (LLM + templates), deterministic validator
  apps/
    agent/              AI treasury agent loop
    guardian/           independent guardian AI service (co-signs large trades)
    relayer/            submits owner-signed commands to the vault through a scoped window
    cli/                owner CLI: keys, sign mandate, STOP, Q-Day, rules, windows
    dashboard/          React (Vite) — status, mandate vs actions, STOP, Q-Day, attack log
    challenge/          "Steal This Agent" page + browser attack console + scoreboard
    attack-bot/         replicates every drill attack; used in CI-style runs and the video
```

Use `viem` for EVM, `@noble/post-quantum` (only if the spike proves byte-compatibility) or the official `qorechain-pqc` / QoreChain SDK, Foundry for contracts, Vitest for TS tests. Credit every one in the README.

## 5. Contract spec — `QillVault.sol`

**State**
- `bytes32 ownerKeyHash` = keccak256(owner ML-DSA pubkey). Pubkey is passed in calldata and checked against the hash.
- `bytes32 guardianKeyHash` (guardian's ML-DSA pubkey hash).
- `address executor` = the agent smart account's EVM address (the only address allowed to call `trade`).
- `uint256 ownerNonce`; `bool paused`; `bool qDayFrozen`.
- `mapping(bytes32 => Mandate) mandates` with:
  `textHash, rulesHash, expiry, status (Active/Revoked), perTradeCap[token], dailyCap[token], softLimit[token], allowedPools[], spentToday[token], dayIndex`.
- Token + pool allowlists.

**Owner-signed actions** (each takes `pubkey, signature, nonce, expiry, params`):
`createMandate`, `revokeMandate`, `pause`, `resume`, `setExecutor`, `setGuardianKey`, `withdraw(to, token, amount)`, `rotateOwnerKey(newPubkeyHash)`, `qDay()`.

**Canonical signed message** (build identically in Solidity and TS — put it in `packages/pq` and a Solidity library, with a cross-language test vector):
```
message = abi.encode(
  "QILLSWITCH_V1",
  block.chainid,        // 9800
  address(this),
  bytes32 action,       // keccak256("CREATE_MANDATE"), ...
  keccak256(params),    // abi-encoded params
  uint256 nonce,        // must equal ownerNonce, then ownerNonce++
  uint64 expiry         // must be >= block.timestamp
)
```
Verify: `keccak256(pubkey) == ownerKeyHash` and `IQorePQC(0x…0A01).pqcVerify(pubkey, sig, message) == true`, then check nonce and expiry. Same pattern for the guardian with action `GUARDIAN_APPROVE_TRADE` and the trade params.

**`trade(mandateId, pool, tokenIn, tokenOut, amountIn, minOut, guardianPubkey, guardianSig)`**
- `msg.sender == executor`, not paused, not frozen, mandate active and not expired, pool in mandate's allowedPools, tokens allowed.
- `amountIn <= perTradeCap`; daily total (reset on UTC day change) `<= dailyCap`.
- If `amountIn > softLimit`: guardian ML-DSA signature over the exact trade params required.
- Approve the pool for **exactly** `amountIn`, swap, require output ≥ `minOut`, **output always to the vault**, reset approval to 0.
- Emit `TradeExecuted(mandateId, pool, tokenIn, tokenOut, amountIn, amountOut, guardianUsed)`.

**Must not exist:** `selfdestruct`, `delegatecall`, any generic `call(target, data)`, upgradeable proxy, `onlyOwner` based on `msg.sender`, `receive()` that does anything clever. Add a reentrancy guard on `trade` and `withdraw`. Use custom errors.

**Tests (Foundry)** — mock the precompile at `0x…0A01` with `vm.etch` (a mock that returns true only for signatures produced by a test signer, or use real ML-DSA vectors generated by the TS package):
- Every owner action fails with: wrong pubkey, bad signature, replayed nonce, expired message, wrong chain ID, wrong contract address, wrong action.
- `trade` fails for: non-executor, paused, frozen, expired/revoked mandate, wrong pool, over per-trade cap, over daily cap, above soft limit without guardian, output to anywhere but the vault, `minOut` not met.
- Daily cap resets on the next UTC day.
- Fuzz all external functions with random callers and inputs: vault balance never decreases except via a valid owner-signed `withdraw` or an in-mandate trade.
- Reentrancy attempt via a malicious mock pool fails.
- Gas report for `pqcVerify` paths.

## 6. Off-chain components

**`packages/pq`** — keygen (store private keys only in files outside the repo, path from `.env`), sign/verify ML-DSA-87, canonical message encoding identical to Solidity, ML-KEM-1024 encrypt/decrypt (stretch). Test vectors shared with Foundry.

**`packages/chain`** — wrappers for: register PQC key, open/close/query EVM window (always pass `--allowed-targets`), create smart account, `update-rules` (always send the full rule array, then read back and diff), register/revoke authenticator, submit `MsgExecuteEVM`, parse events (fail loudly on `abstractaccount_execution_failed`), read nonce after opening a window. Shelling out to `qorechaind` is fine if the SDK can't do something — document which.

**`packages/mandate`**
- JSON schema for a mandate: `{ text, tokens[], pools[], perTradeCap, dailyCap, softLimit, expiryDays, schedule }`.
- Compiler: LLM turns plain English into that JSON, using fixed templates. Then a **deterministic validator** rejects: missing limits, `enabled: false`, expiry > 30 days, unknown pools/tokens, caps above a global ceiling, empty allowlists. Output = (a) smart-account rules JSON, (b) `allowed_evm_calls` = `0x<vault>/0x<trade selector>` only, (c) vault `createMandate` params.
- Show text and compiled rules side by side; owner signs `keccak256(text)` + `keccak256(rules)` together.

**`apps/agent`** — loop: read price from the pool, decide (simple DCA/rebalance strategy + LLM reasoning text for the demo), build trade within the active mandate, get guardian approval if above soft limit, submit via its linked key, check the event, log reasoning + tx hash. Before each step, read `paused`/`qDayFrozen`; stop immediately if set (fail closed if it can't read).

**`apps/guardian`** — separate process, separate model/prompt. Input: mandate + proposed trade + recent history. Output: approve/deny + reason. On approve, sign with the guardian ML-DSA key. It can only veto; it never grants power. Use QCAI if we get API access; otherwise a second LLM via env-configured provider.

**`apps/relayer`** — own PQC-registered account. Opens a window scoped to `--allowed-targets <vault>`, small `max-txs` and `max-value`, few blocks; submits the owner-signed command; closes the window; verifies it's closed.

**`apps/cli`** — `qill keys gen|register`, `qill mandate compile|sign|submit|revoke`, `qill stop`, `qill resume`, `qill qday`, `qill rules show|set`, `qill window open|close|status`, `qill panic` (= close every window we control).

**Q-Day button** — `qill qday` and the dashboard button: (1) owner-signed `qDay()` on every vault, (2) `revoke-authenticator` for every linked key, (3) `close-evm-window` everywhere, (4) re-query and show each item's final state; retry anything not done.

**`apps/dashboard`** — React + Vite. Agent status, active mandate (text + compiled rules + on-chain hash), spend vs caps, activity log with mandate IDs and guardian decisions, STOP and Q-Day buttons (sign locally via the CLI or a local signer service — **the ML-DSA private key never goes into the browser bundle**), attack log. Teal for the owner side, red for the attacker.

**`apps/attack-bot`** — reproduces every drill attack with only the ECDSA key: native transfer, open EVM window, EVM transfer, `approve`, every vault function with junk and replayed signatures, EIP-7702 attempt, plus trades over the cap / wrong pool. Prints a scoreboard: attempts, successes, value moved. Exit non-zero if any attack succeeds.

**`apps/challenge`** — "Steal This Agent": a **separate** challenge agent + vault with small testnet funds and a tight mandate. The page shows the agent's ECDSA private key, a browser attack console (reuse attack-bot logic), and a live scoreboard from chain events. Add a refill script. This key is generated only for the challenge.

## 7. Security rules for you (non-negotiable)

- Never commit private keys, mnemonics or `.env`. Add `.env.example` only. Add a Gitleaks (or similar) check.
- The owner ML-DSA private key is never in the repo, CI, or the browser.
- Never write a spending rule with `enabled: false`; never send a partial `update-rules`.
- Never put routers, forwarders or generic tokens in `allowed_targets`.
- Never grant EIP-7702 consent.
- Never leave an EVM window open on the drill account outside planned moments.
- Don't call any QoreChain API or CLI flag you haven't confirmed in the docs; if unsure, write a spike and ask me.

## 8. Phases

### Phase 1 — Drill-ready (target: done 16 Nov, absolute latest 17 Nov 18:00 IST)
1. Repo scaffold, MIT LICENSE, README skeleton, AI_USAGE.md (start logging now), `.env.example`, secret scanning.
2. **Spikes** (report results before continuing): ML-DSA-87 sign in TS → verify via `pqcVerify` on testnet with `eth_call`; open/close a scoped window; create a smart account + rules + authenticator; submit one `MsgExecuteEVM`.
3. `QillVault` with owner-signed actions, mandates, caps, pool allowlist, pause, Q-Day, guardian check (guardian can be a stub that signs), mocks, full Foundry test suite.
4. Deploy to testnet. Fresh coin-type-60 drill account: register ML-DSA key before funding; configure everything; **close all windows**.
5. Attack bot. Run it against the deployment until 0 successes.
6. `THREAT_MODEL.md` v1. A `DRILL_RUNBOOK.md` with: the normal transaction to send (prefer a hybrid-signed Cosmos-lane tx), panic script, what never to do.
**Deliverable:** deployed addresses, test output, attack-bot scoreboard (0 successes), drill registration details ready for me to submit (account, registered ML-DSA key, ECDSA private key, ≤5 contract addresses).

### Phase 2 — Mandates + agent (19–21 Nov)
Mandate schema, compiler, validator, CLI flow, AI agent loop citing mandate IDs, mock pool liquidity, event checking.

### Phase 3 — Guardian, Q-Day button, dashboard (22–24 Nov)
Real guardian AI service, approval ladder end to end, Q-Day button across all agents, dashboard.

### Phase 4 — Steal This Agent (25–27 Nov)
Separate challenge deployment, public page, attack console, scoreboard, refill script. Launch 27 Nov.

### Phase 5 — Polish and submission (28 Nov–1 Dec)
README (what it is, how to run, track-feature table linking to code, drill results, challenge numbers, addresses, credits), final threat model, featured image, help me script the 3-minute video, final attack-bot run. Stretch only if everything else is done: ML-KEM-1024 encrypted owner commands; MCP / Claude Code gate that checks `paused` before each agent tool call.

**Cut order if behind:** encrypted commands → MCP gate → QCAI (use a second LLM) → dashboard polish. Never cut: mandates, vault tests, ML-DSA checks, Q-Day button, Steal This Agent, threat model.

## 9. Definition of done

- `forge test` passes, including fuzz tests; TS tests pass; attack bot exits 0 with 0 successes against the live testnet deployment.
- README has a table mapping each of the 4 required track features to the exact files/functions.
- A full demo runs from a clean clone with documented commands: compile + sign mandate → agent trades → over-cap trade rejected → guardian veto → STOP → Q-Day button → attack bot all fail.
- No secrets in git history. MIT licence present. All dependencies credited.
- AI_USAGE.md documents how AI was used to build it and how AI runs inside it (agent, compiler, guardian).

Start with Phase 1, step 1 and the spikes. Ask me for anything you need (testnet faucet tokens, LLM API key, which wallet to use). Don't guess.
