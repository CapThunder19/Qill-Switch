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

## Spike 2: open/close a scoped EVM window ⏳

Needs `qorechaind` (not installed here) and a funded account. See "blocked on" in the phase report.

## Spike 3: smart account + rules + authenticator ⏳

Same as spike 2.

## Spike 4: one `MsgExecuteEVM` ⏳

Same as spike 2. Candidate path: `@qorechain/sdk@0.14.0` exposes a `MsgExecuteEVM` composer (per the SDK overview page).

## Other unknowns

| Question | Answer |
|---|---|
| ML-DSA-87 byte encoding | ✅ noble FIPS 204, empty context (spike 1) |
| Block time | ✅ ~1.44 s |
| Faucet location | ⏳ not on the docs pages read so far |
| ERC-20 amounts counted by AA spending rules? | ⏳ |
| DEX on testnet? | ⏳ will deploy `MockPool` unless one is found |
