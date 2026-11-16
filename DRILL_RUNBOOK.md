# Q-Day Drill runbook

**Drill window:** 18 Nov 2026, 00:00–23:59 UTC (05:30 18 Nov – 05:29 19 Nov IST).
**Threat:** a bot holds the drill account's **ECDSA** private key and tries native transfers, opening EVM
windows, EVM transfers, token approvals and drain calls on our contracts.

## What we registered

| Item | Value |
|---|---|
| Drill account (EVM) | `0x93c91b9c0ae17023FDe445c99Cb435557FA10499` |
| Drill account (native) | `qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l` |
| Key type | `eth_secp256k1` (coin type 60), unified account |
| Registered PQC key | ML-DSA-87, `possessionProven = true`; keccak256(pubkey) = `0x965e4a75f0dc1f7eb734a3734b12099542ea62d9cbc965bf3e2dd673871792d0` |
| ECDSA private key | handed to the organisers from `~/.qill/keys/drill.ecdsa.json` (never in git) |
| Contracts | QillVault `0x6B06108FB72c3E93eCa391E5DabeE4F141e9D365`, MockPool `0x87d69892fe9019004e38eCC5cf746Ee67b44CE4C`, Token A `0xB1253Fe7f230Fa0e58D8a97Bb2142AE5250FB18A`, Token B `0xB7484fa7Bc3D44B20E58941528A2dCFdA6B2DEFD` |

The ML-DSA key is derived from a **separate** 32-byte secret (`drill.pqc-secret.json`), not from the ECDSA key,
so the drill bot learns nothing about it.

## Posture going into the drill

- Drill account: **no EVM window** (stored or live). Check: `pnpm chain:status drill`.
- QillVault: **paused**, `executor = 0x0`, no mandates. Every state change needs an owner ML-DSA-87 signature.
- The drill account holds **no tokens**; Token A/B liquidity sits in the pool (no remove function) and the vault.
- Funder/relayer account: no live window.

## Expected result for every attack

| Attack | Stopped by |
|---|---|
| Native transfer, classical sig | chain ante: `pqc/20` hybrid signature required |
| Native transfer, forged hybrid (bot's own ML-DSA key) | chain ante: `pqc/21` PQC signature verification failed |
| Open EVM window (any scope) | `pqc/20` / `pqc/21`: needs the real ML-DSA key |
| Re-register / replace PQC key | `pqc/234`: account already has a key |
| EIP-7702 consent / type-4 tx | `pqc/20` / no EVM window |
| EVM transfer, `approve`, `transferFrom`, deploy | no open EVM authorisation window |
| Any QillVault function | no EVM window; even simulated, reverts `BadSignature` / `WrongKey` / `BadNonce` / `NotExecutor` |

Reproduce all of it: `pnpm attack` (exits 1 if anything succeeds). Last run: [docs/attack-bot-final-drill.txt](docs/attack-bot-final-drill.txt), 34 attempts (incl. linking an attacker key through account abstraction), 0 successes.

## During the drill

**The normal transaction** (proof the project works) is a hybrid-signed Cosmos-lane transfer. It needs no
EVM window, so the drill account never has one:

```sh
pnpm --filter @qill/chain exec tsx scripts/normal-tx.ts       # 0.01 QOR drill → funder, hybrid-signed
```

Run it once early in the drill window (and again near the end if useful). Record the tx hash here.

**Monitor:**

```sh
pnpm chain:status drill      # window must be found=false / live=false
pnpm attack                  # optional: our own replay, must stay 0 successes
```

## Panic

If anything looks wrong (a window appears, balance drops, unexpected tx):

```sh
pnpm --filter @qill/chain exec tsx scripts/panic.ts
```

It closes every window on every account we control, retries up to 3 times, then prints the final window and
vault state. If the vault itself needs to be frozen: `pnpm owner qDay` (irreversible; owner can still
`withdraw` with the ML-DSA key afterwards).

## Never do during the drill

- Never open an EVM window on the drill account. No deploys, no EVM txs from it. Use the Cosmos-lane normal tx.
- Never grant EIP-7702 consent (`MsgAuthorizeEVMDelegation`) from any account.
- Never `resume` the vault or set an executor.
- Never send the drill account more funds than it already has.
- Never share `*.pqc-secret.json`, `owner.mldsa.json` or `guardian.mldsa.json`. Only `drill.ecdsa.json` goes to the organisers.
- Never paste keys into a browser, chat, or CI.
