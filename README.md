# Qill Switch

**Quantum-signed mandates for AI agents on QoreChain.**

> QoreChain limits where your agent can go. Qill Switch limits what it may do, and stops it with one quantum-safe signature.

The owner gives an AI agent a *mandate*: plain-English instructions compiled into on-chain rules and signed with an **ML-DSA-87** key. The agent can only act inside the mandate. Anything that loosens control (a new mandate, a higher limit, resume, withdraw, a new owner key) needs the owner's ML-DSA signature, checked on chain by QoreChain's `pqcVerify` precompile. A stolen classical ECDSA key alone can never loosen anything. Large trades also need a co-signature from an independent **guardian AI**. A **Q-Day button** revokes every classical agent key, closes every EVM window and freezes every vault with one signature.

Built for the QoreChain "Build Before Q-Day" Developer Fest, track **Post-Quantum AI Agents**.

## Status

🚧 Phase 1 (drill-ready) in progress.

## Track features → code

| Required feature | Where |
|---|---|
| Scoped EVM window | `packages/chain` (window helpers, always `--allowed-targets`), `apps/relayer` *(in progress)* |
| Limits on transactions, value, duration and target | `contracts/src/QillVault.sol` (per-trade cap, daily cap, expiry, pool allowlist) *(in progress)* |
| Smart-account spending rules | `packages/chain` (AA rules), `packages/mandate` (compiler + validator) *(in progress)* |
| Authenticated messaging | `contracts/src/libraries/QillMessage.sol` + `packages/pq` (ML-DSA-87 canonical messages) *(in progress)* |

## Repo layout

```
contracts/      Foundry: QillVault, IQorePQC, mocks, tests
packages/pq     ML-DSA-87 helpers + canonical message encoding
packages/chain  EVM (viem) + Cosmos helpers
packages/mandate mandate schema, compiler, validator
apps/*          agent, guardian, relayer, cli, dashboard, challenge, attack-bot
```

## Testnet addresses

_To be filled after deployment._

## Credits

- [Foundry](https://github.com/foundry-rs/foundry) (MIT/Apache-2.0): contract build and test
- [forge-std](https://github.com/foundry-rs/forge-std) (MIT/Apache-2.0)
- [viem](https://viem.sh) (MIT): EVM client
- [@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum) (MIT): ML-DSA-87 / ML-KEM-1024
- [@qorechain/sdk](https://www.npmjs.com/package/@qorechain/sdk), [@qorechain/evm](https://www.npmjs.com/package/@qorechain/evm): QoreChain SDK
- [Vitest](https://vitest.dev) (MIT), [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://www.typescriptlang.org) (Apache-2.0)
- [Gitleaks](https://github.com/gitleaks/gitleaks) (MIT): secret scanning

## License

[MIT](LICENSE)
