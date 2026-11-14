# Threat model (v1, Phase 1)

## Assets

| Asset | Where |
|---|---|
| Vault funds (Token A/B, native QOR) | `QillVault` |
| Control of the vault (owner key, guardian key, executor, mandates, pause/Q-Day state) | `QillVault` storage |
| Drill account native QOR | chain bank module |
| Owner / guardian ML-DSA-87 secret keys | `~/.qill/keys/*.mldsa.json`, offline from the repo |
| Account PQC secrets | `~/.qill/keys/*.pqc-secret.json` |

## Adversaries

1. **Q-Day adversary**: holds (or can derive) any account's **classical ECDSA** key. This is the drill bot.
2. **Malicious or compromised AI agent**: controls the executor key and proposes trades.
3. **Malicious pool / token**: a contract the vault interacts with behaves adversarially.
4. **Network observer**: sees every signed command in calldata and can replay or re-target it.

## Controls

### A. Chain layer (QoreChain)
- Every Cosmos-lane tx from a PQC account must carry a valid ML-DSA-87 hybrid signature (`pqc/20`, `pqc/21`).
- EVM txs are admitted only inside an EVM authorisation window, which can only be opened by a hybrid-signed tx.
- A PQC key cannot be re-registered by the classical key (`pqc/234`); rotation needs the old PQC key.
- EIP-7702 delegation requires PQC-signed consent; we never grant it.

### B. Contract layer (`QillVault`)
- **No `msg.sender` ownership.** All power is gated by `_authOwner`: `keccak256(pubkey) == ownerKeyHash`, nonce ==
  `ownerNonce`, `expiry >= now`, and `pqcVerify(pubkey, sig, message)` through the typed interface.
- **Domain separation.** `message` binds domain tag, chain id, vault address, action id, keccak256(params), nonce
  and expiry, so a signature cannot be replayed on another chain, vault, action, parameter set or nonce.
- **Fail closed on an inactive precompile.** Empty return data from `0x…0A01` makes the ABI decode revert.
- **Trades** only from `executor`, only when not paused or frozen, only inside an active, unexpired mandate:
  pool allowlisted globally and per mandate, both tokens allowed, per-trade cap, UTC-daily cap, guardian
  ML-DSA co-signature above the soft limit (own nonce + expiry, bound to the exact trade params).
- **Pool interaction**: approve exactly `amountIn`, reset to 0 after; output measured by the vault's balance delta
  (pool return values are ignored); output always to the vault; `minOut` enforced; pool cannot pull more.
- **Reentrancy guard** on `trade` and `withdraw`.
- **Q-Day** is irreversible: freezes trading, pauses, clears the executor; blocks resume, setExecutor,
  createMandate and allowlist additions. Owner can still withdraw with the PQ key.
- Absent by design: selfdestruct, delegatecall, generic call(target,data), proxies, upgrades.

### C. Operations
- Account ML-DSA keys come from an independent secret (`unifiedAccountFromSeed(seed, { pqcSecret })`), not the mnemonic/ECDSA key.
- Drill account registered its PQC key while holding only the registration fee.
- EVM windows: scoped to the vault for relayed commands (`maxTxs = 1`, value = exact max fee, ≤120 blocks),
  closed and verified closed after use. The single unscoped window was used for deployment only, sized to the
  exact tx count and closed immediately.
- Keys live outside the repo (`QILL_KEY_DIR`); scripts refuse paths inside it; Gitleaks in CI.

## Known residual risks / open items

| Risk | Status |
|---|---|
| Owner ML-DSA key on the same machine as the dev environment | Accepted for testnet; move to an offline signer before mainnet |
| Mock pool pricing is manipulable (no oracle) | Caps and `minOut` bound the loss per trade/day; real DEX not used |
| Smart-account spending rules (x/abstractaccount) not yet configured | Phase 2: agent will act only through a linked key limited to `vault.trade` |
| Guardian is a signer, not yet an AI service | Phase 3 |
| `pqcVerify` cost (~85–90k gas + ~7.5 KB calldata per signature) | Measured: owner `pause` = 283k gas total |
| Funds sent directly to the drill account by third parties | Cannot be moved without the ML-DSA key |
