# Spikes

Results of the experiments the build brief asks for before writing contracts. Re-run any spike with
`cd spikes && pnpm exec tsx <file>`.

## Spike 1: ML-DSA-87 in TypeScript → `pqcVerify` on testnet ✅

`spikes/01-pqc-verify.ts` (read-only `eth_call`, no funds needed). Run on 2026-11-14 against `https://evm-testnet.qore.host`:

```
chainId 9800 block 10074796n avg block time (s, last 100) 1.44
noble FIPS204 empty ctx (expected true)      -> true
tampered signature (expected false)          -> false
wrong message (expected false)               -> false
wrong pubkey (expected false)                -> false
signed keccak(msg), passed keccak(msg)       -> true
context='qorechain' (diagnostic)             -> false
estimateGas pqcVerify 316470n
pqcKeyStatus(random addr) [ false, 0, '0x', false ]
```

**Findings**
- `@noble/post-quantum@0.7.1` `ml_dsa87.sign(msg, sk)` (pure FIPS 204 ML-DSA-87, **empty context**) is byte-compatible with
  the precompile. The precompile verifies the raw message bytes it is given (no extra hashing, no context string).
  We do not need a separate `qorechain-pqc` library (no such npm package exists anyway).
- Invalid inputs return `false`; they do not revert. The vault must therefore `require(valid)` itself.
- Gas: `estimateGas` for a direct call with a ~0.3 KB message is ~316k **including** intrinsic calldata cost
  (~7.5 KB calldata). The docs' 25,000 + 8/byte is the precompile execution cost only.
- Testnet block time ≈ **1.44 s** (so 17,280 blocks ≈ 6.9 h, not 24 h).
- `pqcKeyStatus(address) returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)` at `0x…0A02`
  is documented on the precompiles page and works on testnet. We use it as an extra off-chain check.
- viem needs the precompile addresses lowercase (mixed-case `0x…0A01` fails its checksum check).

## Tooling decision: `@qorechain/sdk` instead of `qorechaind`

`@qorechain/sdk@0.14.0` covers everything Phase 1 needs, so we do not shell out to `qorechaind`:
unified eth_secp256k1 accounts (`unifiedAccountFromSeed`), `MsgRegisterPQCKeyV2` + proof of possession
(`buildRegisterPqcKeyMsg`, `signProofOfPossession`), hybrid Cosmos-lane signing (`EthNativeSigner`),
`openEvmWindowMsg` / `closeEvmWindowMsg` / `fetchEvmWindow`, spending rules, authenticators and
`executeEvmMsg`. Wrappers live in `packages/chain/src/cosmos.ts`.

Read-only checks against testnet (2026-11-14, `pnpm chain:status`):
- REST `https://api-testnet.qore.host`, RPC `https://rpc-testnet.qore.host`.
- `GET /qorechain/pqc/v1/evm_limits` → `tx_max_gas 30000000`, `precompile_input_max_bytes 16384`.
- `GET /qorechain/abstractaccount/v1/config` → `enabled: true, max_session_keys 10, max_spending_rules 5`.

**Findings that change the plan**
- **Key separation:** accounts are built with `unifiedAccountFromSeed(seed, { pqcSecret })`, where `pqcSecret`
  is independent of the ECDSA key. The drill bot gets the ECDSA key and learns nothing about the ML-DSA key.
  (`deriveUnifiedAccount(mnemonic)` derives both from one mnemonic, so we avoid it.)
- **"Register before funding"** cannot be literal: an account does not exist on chain (no account number)
  until it receives funds. Bootstrap therefore sends the drill account *only* the registration fee
  (0.15 QOR) from a separate funder account, registers immediately, verifies, then tops up.
- **Scoped windows refuse contract creation** (`allowedTargets` doc in `@qorechain/evm/window`). Deployment
  needs one short unscoped window (few blocks, `maxTxs` = number of contracts, tight `maxValue`), closed
  right after. `openWindow()` refuses an unscoped window unless `allowContractCreation` is set.
- `maxValue` counts value **plus** `gasLimit × maxFeePerGas` of every admitted tx, in uqor (1 uqor = 1e12 wei).
- **Faucet:** a sign-in web form at `dashboard.qorechain.io/faucet` (100 QOR / 24 h), no API. A human claims it.
- PQC key status precompile `0x…0A02` reports `possessionProven`; bootstrap checks it.

## Spike 2: open/close a scoped EVM window ✅

Relayer opened a window with `allowedTargets = [vault]`, `maxTxs = 1`, `maxValue = 68,332 uqor`, 120 blocks; sent the
owner-signed `pause()` (tx `0x555b810a…ee47`, 283,041 gas, real ML-DSA-87 signature through `pqcVerify`); closed
and verified closed. Window query read the scope back as exactly the vault.

## Spike 3: smart account + rules + authenticator ⏳

Same as spike 2.

## Spike 4: one `MsgExecuteEVM` ⏳

Same as spike 2. Candidate path: `@qorechain/sdk@0.14.0` exposes a `MsgExecuteEVM` composer (per the SDK overview page).

## Other unknowns

| Question | Answer |
|---|---|
| ML-DSA-87 byte encoding | ✅ noble FIPS 204, empty context (spike 1) |
| Block time | ✅ ~1.44 s |
| Faucet location | ✅ dashboard.qorechain.io/faucet (sign-in form, 100 QOR / 24 h) |
| ERC-20 amounts counted by AA spending rules? | ⏳ |
| DEX on testnet? | ⏳ will deploy `MockPool` unless one is found |
