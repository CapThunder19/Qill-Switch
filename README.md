# Qill Switch

**Quantum-signed mandates for AI agents on QoreChain.**

> QoreChain limits where your agent can go. Qill Switch limits what it may do, and stops it with one quantum-safe signature.

The owner gives an AI agent a *mandate*: plain-English instructions compiled into on-chain rules and signed with an **ML-DSA-87** key. The agent can only act inside the mandate. Anything that loosens control (a new mandate, a higher limit, resume, withdraw, a new owner key) needs the owner's ML-DSA signature, checked on chain by QoreChain's `pqcVerify` precompile. A stolen classical ECDSA key alone can never loosen anything. Large trades also need a co-signature from an independent **guardian AI**. A **Q-Day button** revokes every classical agent key, closes every EVM window and freezes every vault with one signature.

Built for the QoreChain "Build Before Q-Day" Developer Fest, track **Post-Quantum AI Agents**.

## Status

✅ **Phase 1 (drill-ready)** deployed on testnet. Attack bot: 32 attempts, **0 successes**, 0 value moved ([run](docs/attack-bot-run-1.txt)). See [DRILL_RUNBOOK.md](DRILL_RUNBOOK.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

✅ **Phase 2 (mandates + agent)** live on a separate demo vault: plain English → validated mandate → owner ML-DSA-87 signature
→ smart-account rules → AI agent trades through `MsgExecuteEVM` citing the mandate id; STOP makes the agent fail closed.

✅ **Phase 3 (guardian, Q-Day, dashboard)**: trades above the soft limit are co-signed by a separate guardian service
(ML-DSA-87) or vetoed; the Q-Day button froze a test fleet, revoked its agent key and closed its windows in one round
([run](docs/qday-test-run-1.txt)); the dashboard signs STOP / RESUME / Q-Day in a localhost API, never in the browser.

✅ **Phase 4 (Steal This Agent)**: a separate challenge deployment publishes both the challenge account's classical key
and the AI agent's key. Our attack bot: 39 attempts, **0 successes** ([run](docs/challenge-attack-run-1.txt)).
Page source in [apps/challenge](apps/challenge); launch with the manual `challenge-pages` workflow.

## Track features → code

| Required feature | Where |
|---|---|
| Scoped EVM window | [packages/chain/src/cosmos.ts](packages/chain/src/cosmos.ts) `openWindow` (refuses unscoped windows) and [packages/chain/src/vault.ts](packages/chain/src/vault.ts) `relayToVault` (window scoped to the vault, 1 tx, exact fee budget, closed and verified) |
| Limits on transactions, value, duration and target | [QillVault.sol](contracts/src/QillVault.sol) `trade`: per-trade cap, UTC-daily cap, mandate expiry, pool/token allowlists; windows: `maxTxs`, `maxValue`, `blocks`, `allowedTargets` |
| Smart-account spending rules | [packages/chain/src/aa.ts](packages/chain/src/aa.ts) `agentRule` / `linkAgentKey` / `setRules` (one enabled rule bounding every denom, `allowed_evm_calls` = `vault/trade` only, full-replace + read-back diff; agent key linked with `evm` permission only) and [packages/mandate/src/compile.ts](packages/mandate/src/compile.ts) (compiles the rule from the mandate) |
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
pnpm --filter @qill/mandate test  # parser, validator, compiler, LLM path behind the validator
```

## Phase 2 demo (demo vault, never the drill vault)

```sh
pnpm qill mandate compile "Trade QTA and QTB on demo-pool. Max 50 per trade, 150 per day, guardian above 20, for 5 days."
pnpm qill mandate submit mandates/<id>.json      # side-by-side review, owner ML-DSA-87 signature, smart-account rules
pnpm agent --once                                # one agent step (decide, trade via MsgExecuteEVM, verify, log)
pnpm qill stop                                   # agent now refuses to act (fails closed)
pnpm qill resume
pnpm qill status
```

## Phase 3 demo

```sh
pnpm guardian                                    # terminal 1: guardian service on 127.0.0.1:8787
pnpm agent --once --drift-bps 0 --amount 30      # above the soft limit → guardian co-signs → trade
pnpm agent --once --drift-bps 0 --amount 60      # above the per-trade cap → guardian vetoes → agent downsizes to 20
pnpm dashboard:build && pnpm dashboard:api       # terminal 2: open http://127.0.0.1:8788, paste the printed token
pnpm qill fleet status --fleet production        # what Q-Day would freeze / revoke / close
pnpm qill qday --fleet qday-test                 # the Q-Day button (fleet must be named explicitly)
```

## Steal This Agent

```sh
pnpm --filter @qill/chain exec tsx scripts/setup-challenge.ts   # idempotent: accounts, deployment, agent key, mandate, sweep, challenge.json
pnpm attack --target challenge                                  # every attack, incl. the published agent key via MsgExecuteEVM
pnpm challenge:refill                                           # integrity check vs baseline + top the bait back up to 3 QOR
pnpm challenge:dev                                              # the public page locally (http://127.0.0.1:5174)
```

Launch: repo **Settings → Pages → Source: GitHub Actions**, then run the **challenge-pages** workflow from the Actions tab.

| Challenge item | Address |
|---|---|
| Challenge account (key published, holds the bait) | `0x2A2F8F87C3C422E3369fA45dCE8de9269f685b66` |
| Agent smart account (vault executor, 0 QOR) | `0xA073EcFEF809651162AEDf3bdeB776E4cAcaA922` |
| Agent key (published, `evm` only) | `0x828fA45077fa6cA0616D650E9914bB2Eb03D95C3` |
| Challenge contracts | [deployments/challenge.json](deployments/challenge.json) |

Add `--llm` to `mandate compile` to extract the draft with Claude (`claude-opus-5-5`, structured output); it needs
`ANTHROPIC_API_KEY`. Either way the deterministic validator decides what can be signed.

## Phase 1 commands

```sh
pnpm keys:gen               # generate keys outside the repo (~/.qill/keys)
pnpm chain:bootstrap        # register ML-DSA keys (drill registers holding only the fee), fund drill
pnpm chain:deploy -- --execute
pnpm owner pause            # owner-signed command via a vault-scoped window
pnpm attack                 # replay every drill attack with only the ECDSA key
pnpm panic                  # close every window we control
```

## Testnet addresses

QoreChain testnet `qorechain-diana` (EVM chain id 9800). Source of truth: [deployments/qorechain-diana.json](deployments/qorechain-diana.json).

| Contract | Address |
|---|---|
| QillVault | `0x6B06108FB72c3E93eCa391E5DabeE4F141e9D365` |
| MockPool | `0x87d69892fe9019004e38eCC5cf746Ee67b44CE4C` |
| Token A (QTA) | `0xB1253Fe7f230Fa0e58D8a97Bb2142AE5250FB18A` |
| Token B (QTB) | `0xB7484fa7Bc3D44B20E58941528A2dCFdA6B2DEFD` |
| Drill account | `0x93c91b9c0ae17023FDe445c99Cb435557FA10499` / `qor1j0y3h8q2u9cz8l0yghyeedp424l6zpyej8e06l` |

A second, unused set (`QillVault 0xDf8fb77C…78c7`) was deployed by mistake by a tooling error; it is recorded in
[deployments/qorechain-diana-accidental-2.json](deployments/qorechain-diana-accidental-2.json) and is not part of the drill.

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
