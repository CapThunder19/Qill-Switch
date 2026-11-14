# Qill Switch

**Quantum-signed mandates for AI agents on QoreChain.**

> QoreChain limits where your agent can go. Qill Switch limits what it may do, and stops it with one quantum-safe signature.

The owner gives an AI agent a *mandate*: plain-English instructions compiled into on-chain rules and signed with an **ML-DSA-87** key. The agent can only act inside the mandate. Anything that loosens control (a new mandate, a higher limit, resume, withdraw, a new owner key) needs the owner's ML-DSA signature, checked on chain by QoreChain's `pqcVerify` precompile. A stolen classical ECDSA key alone can never loosen anything. Large trades also need a co-signature from an independent **guardian AI**. A **Q-Day button** revokes every classical agent key, closes every EVM window and freezes every vault with one signature.

Built for the QoreChain "Build Before Q-Day" Developer Fest, track **Post-Quantum AI Agents**.

## Status

✅ **Phase 1 (drill-ready)** deployed on testnet. Attack bot: 32 attempts, **0 successes**, 0 value moved ([run](docs/attack-bot-run-1.txt)). See [DRILL_RUNBOOK.md](DRILL_RUNBOOK.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

## Track features → code

| Required feature | Where |
|---|---|
| Scoped EVM window | [packages/chain/src/cosmos.ts](packages/chain/src/cosmos.ts) `openWindow` (refuses unscoped windows) and [packages/chain/src/vault.ts](packages/chain/src/vault.ts) `relayToVault` (window scoped to the vault, 1 tx, exact fee budget, closed + verified) |
| Limits on transactions, value, duration and target | [QillVault.sol](contracts/src/QillVault.sol) `trade`: per-trade cap, UTC-daily cap, mandate expiry, pool/token allowlists; windows: `maxTxs`, `maxValue`, `blocks`, `allowedTargets` |
| Smart-account spending rules | `packages/chain` (AA rules), `packages/mandate` (compiler + validator) *(in progress)* |
| Authenticated messaging | [QillMessage.sol](contracts/src/libraries/QillMessage.sol) + [packages/pq/src/message.ts](packages/pq/src/message.ts): domain-separated ML-DSA-87 messages verified on chain by `pqcVerify` (`QillVault._authOwner`, `_authGuardian`) |

## Repo layout

```
contracts/      Hardhat 3: QillVault, IQorePQC, mocks, Solidity tests (forge-std style)
packages/pq     ML-DSA-87 helpers + canonical message encoding
packages/chain  EVM (viem) + Cosmos helpers
packages/mandate mandate schema, compiler, validator
apps/*          agent, guardian, relayer, cli, dashboard, challenge, attack-bot
```

## Run the tests

```sh
pnpm install
pnpm test:contracts         # 42 Solidity tests via Hardhat 3 (unit, fuzz x1000, invariant x256)
pnpm test:gas               # same, with gas statistics
pnpm --filter @qill/pq test # ML-DSA-87 + canonical message tests
```

## Phase 1 commands

\{
  "keyDir": "C:\Users\aniru\.qill\keys",
  "funder": {
    "created": false,
    "evm": "0xd7a5D19c85C86Ae8919Bca28E24CC494d76752Bc",
    "cosmos": "qor167jar8y9ep4w3yvmeg5wynxyjntkw54ujmfuvd",
    "pqcPublicKeyHash": "0x5040c68f6093c9051abe1a105f835356fc5272233df18248dd583df48aa343fa"
  },
  "drill": {
    "created": false,
    "evm": "0x93c91b9c0ae17023FDe445c99Cb435557FA10499",
    "cosmos": "qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l",
    "pqcPublicKeyHash": "0x965e4a75f0dc1f7eb734a3734b12099542ea62d9cbc965bf3e2dd673871792d0"
  },
  "owner": {
    "created": false,
    "mldsaPublicKeyHash": "0x6ffd24954fd6fece9e7e8b8c446505480f1db24f2ee1aa256144fbe93709b9b1"
  },
  "guardian": {
    "created": false,
    "mldsaPublicKeyHash": "0x3975bcca633502ef08d20ee2970690469e6f28021a90e5778c092c7078ef2cdc"
  }
}
[funder] qor167jar8y9ep4w3yvmeg5wynxyjntkw54ujmfuvd balance 79.453157 QOR
[funder] register: already registered
[funder] verify: rest.registered=true precompile.registered=true alg=1 possessionProven=true keyMatches=true
[drill] register: already registered
[drill] verify: rest.registered=true precompile.registered=true alg=1 possessionProven=true keyMatches=true
[funder→drill] top-up 788090 uqor tx 453F4F4E4E600C41FBF34A675733D721A95BA20785B1F58CBDFE020C9B1678F7
[funder] window live=false  balance=78.590067 QOR
[drill] window live=false  balance=20 QOR

bootstrap complete
No contracts to compile
deployer 0x93c91b9c0ae17023FDe445c99Cb435557FA10499 balance 20 QOR
gasPrice 112500000000n maxFee 168750000000n window maxValue 1177431n uqor = 1.177431 QOR
  deploy Token A       gas 645006
  deploy Token B       gas 645006
  deploy MockPool      gas 619507
  deploy QillVault     gas 3893529
  A.approve(pool)      gas 80000
  B.approve(pool)      gas 80000
  pool.addLiquidity    gas 220000
  A.transfer(vault)    gas 80000
  B.transfer(vault)    gas 80000
predicted: {
  tokA: '0xF2012D9957C2A9527352aA45BA9853aF0a2E0566',
  tokB: '0x892B885FFAFCF29b3647bf18347cD3E1B1A4b08e',
  pool: '0x271BDF77bEc76E0bd16658e435e099C6968F324B',
  vault: '0xDf8fb77C1606A3026EAcdFb6fa8F4F6dB59878c7'
}
window opened 0D22AB9BDEA9F979991001A4B30181A6ADED0AA17069CBFAE83340C5FD208F35
  deploy Token A       success 0xeda33f37fe7eacda431f881d1cfdf9f7dfe47ee511a9e982262440678601ae17 -> 0xf2012d9957c2a9527352aa45ba9853af0a2e0566
  deploy Token B       success 0x5b5f50d89c75ee7e2ec2f8a343b410d0bbf334d8415da13735b61dd8425bfe13 -> 0x892b885ffafcf29b3647bf18347cd3e1b1a4b08e
  deploy MockPool      success 0x2503610d280703313362eb2896b712a726f9a7850bf8ab34c463773ca37a67c8 -> 0x271bdf77bec76e0bd16658e435e099c6968f324b
  deploy QillVault     success 0xb42b236e4319d821d646c5065b4e1ab823580337ca9f78414286e2643ddd1076 -> 0xdf8fb77c1606a3026eacdfb6fa8f4f6db59878c7
  A.approve(pool)      success 0x9cc54c1efc0279008b88d5ae3b37d5b3b01620f2c670b9eeb03193bfa8ef90ef
  B.approve(pool)      success 0x9cf7499301b2a1260b8d86b946232b361b8a746230ea6ca7dbd634b5c0442990
  pool.addLiquidity    success 0x11a77a9c9e1fc86f8c35522f0a53412b151004c4ab9d75f7c055305ade99e925
  A.transfer(vault)    success 0x8535772136af81a22201ed297db68133b645379c9832af859ecc69b5ccc64fe5
  B.transfer(vault)    success 0x8c21403452adaa7aaabc867d555933338a009decbd389de24ba1d255e2e2e8a1
window closed E9C769F7B60A4CA55ED118C5C07DE1615A9223C10C395C3A77423A2A69CADED9 live now: false
checks {
  ownerKeyHash: true,
  guardianKeyHash: true,
  executorIsZero: true,
  tokenAAllowed: true,
  tokenBAllowed: true,
  poolAllowed: true,
  vaultA: true,
  vaultB: true,
  drillHoldsNoA: true,
  drillHoldsNoB: true
}
wrote deployments/qorechain-diana.json
attack bot | target qorechain-diana | drill 0x93c91b9c0ae17023FDe445c99Cb435557FA10499 (qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l) | vault 0xDf8fb77C1606A3026EAcdFb6fa8F4F6dB59878c7
drill EVM window: found=false live=false

ok [cosmos] native transfer (classical sig)                blocked  pqc/20: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key and must include the hybri
ok [cosmos] native transfer (forged hybrid, attacker ML-DSA) blocked  pqc/21: PQC signature verification failed for qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l: hybrid PQC signature
ok [cosmos] open EVM window, unscoped (classical)          blocked  pqc/20: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key and must include the hybri
ok [cosmos] open EVM window, unscoped (forged hybrid)      blocked  pqc/21: PQC signature verification failed for qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l: hybrid PQC signature
ok [cosmos] open EVM window scoped to tokens (classical)   blocked  pqc/20: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key and must include the hybri
ok [cosmos] register attacker PQC key (classical)          blocked  pqc/234: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key; register and migrate nee
ok [cosmos] EIP-7702 delegation consent (classical)        blocked  pqc/20: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key and must include the hybri
ok [cosmos] EIP-7702 delegation consent (forged hybrid)    blocked  pqc/21: PQC signature verification failed for qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l: hybrid PQC signature
ok [cosmos] close EVM window (classical, griefing)         blocked  pqc/20: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has a registered PQC key and must include the hybri
ok [evm] native QOR transfer                            blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window
ok [evm] Token A approve(attacker, max)                 blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window
ok [evm] Token A transferFrom(vault)                    blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window
ok [evm] deploy contract                                blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window
ok [evm] EIP-7702 type-4 delegation tx                  blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window
ok [vault] withdraw native, junk signature                blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] withdraw Token A, junk signature               blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] withdraw, attacker ML-DSA key + VALID sig      blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] setExecutor(attacker), junk signature          blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] resume, junk signature                         blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] rotateOwnerKey(attacker), junk signature       blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] setGuardianKey(attacker), junk signature       blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] setAllowlist(attacker pool), junk signature    blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] qDay (griefing), junk signature                blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] pause (griefing), junk signature               blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] createMandate(attacker), junk signature        blocked  reverts WrongKey | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] trade (not executor)                           blocked  reverts NotExecutor | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] trade over cap                                 blocked  reverts NotExecutor | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] trade via attacker 'pool'                      blocked  reverts NotExecutor | send refused: account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no op
ok [vault] send native to vault + junk                    blocked  account qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l has no open EVM authorisation window

================ SCOREBOARD ================
attempts:          29
successes:         0
value moved:       drill 0 QOR; vault/pool decreased: none
vault control:     unchanged (nonce 0, paused false, executor 0x0000000000000000000000000000000000000000)
=============================================
## Testnet addresses

QoreChain testnet  (EVM chain id 9800). Source of truth: [deployments/qorechain-diana.json](deployments/qorechain-diana.json).

| Contract | Address |
|---|---|
| QillVault |  |
| MockPool |  |
| Token A (QTA) |  |
| Token B (QTB) |  |
| Drill account |  /  |

## Credits

- [Hardhat 3](https://hardhat.org) + [hardhat-toolbox-viem](https://www.npmjs.com/package/@nomicfoundation/hardhat-toolbox-viem) (MIT): contract build, Solidity tests (fuzz + invariant), deployment
- [forge-std](https://github.com/foundry-rs/forge-std) (MIT/Apache-2.0): test cheatcodes and assertions, run by Hardhat's Solidity test runner
- [viem](https://viem.sh) (MIT): EVM client
- [@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum) (MIT): ML-DSA-87 / ML-KEM-1024
- [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk), [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm): QoreChain SDK
- [Vitest](https://vitest.dev) (MIT), [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://www.typescriptlang.org) (Apache-2.0)
- [Gitleaks](https://github.com/gitleaks/gitleaks) (MIT): secret scanning

## License

[MIT](LICENSE)
