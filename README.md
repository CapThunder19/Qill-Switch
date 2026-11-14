# Qill Switch

**Quantum-signed mandates for AI agents on QoreChain.**

> QoreChain limits where your agent can go. Qill Switch limits what it may do, and stops it with one quantum-safe signature.

The owner gives an AI agent a *mandate*: plain-English instructions compiled into on-chain rules and signed with an **ML-DSA-87** key. The agent can only act inside the mandate. Anything that loosens control (a new mandate, a higher limit, resume, withdraw, a new owner key) needs the owner's ML-DSA signature, checked on chain by QoreChain's `pqcVerify` precompile. A stolen classical ECDSA key alone can never loosen anything. Large trades also need a co-signature from an independent **guardian AI**. A **Q-Day button** revokes every classical agent key, closes every EVM window and freezes every vault with one signature.

Built for the QoreChain "Build Before Q-Day" Developer Fest, track **Post-Quantum AI Agents**.

## Status

✅ **Phase 1 (drill-ready)** deployed on testnet. Attack bot: 32 attempts, **0 successes**, 0 value moved ([run](docs/attack-bot-run-1.txt)). See [DRILL_RUNBOOK.md](DRILL_RUNBOOK.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

✅ **Phase 2 (mandates + agent)** live on a separate demo vault: plain English → validated mandate → owner ML-DSA-87 signature
→ smart-account rules → AI agent trades through `MsgExecuteEVM` citing the mandate id; STOP makes the agent fail closed.

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
