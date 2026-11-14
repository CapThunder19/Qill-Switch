# AI usage

This file records how AI was used to **build** Qill Switch and how AI **runs inside** it.

## AI used to build the project

| Date (UTC) | Tool | What it did | Human review |
|---|---|---|---|
| 2026-11-14 | AI coding assistant | Read the build brief (`QILL_SWITCH_BUILD_PROMPT.md`), scaffolded the monorepo, LICENSE, README skeleton, `.env.example`, Gitleaks config | Reviewed by owner before push |
| 2026-11-14 | AI coding assistant | Wrote `packages/pq` (ML-DSA-87 + canonical message), cross-language vectors and spike 1 (live `pqcVerify` check) | Spike output checked against testnet |
| 2026-11-14 | AI coding assistant | Wrote `QillVault.sol`, mocks, Foundry unit/fuzz/invariant tests; compile-checked with solc 0.8.24 (viaIR) | Owner to review contract |
| 2026-11-14 | AI coding assistant | Switched contracts to Hardhat 3 (owner request), fixed a test-helper overflow; 42/42 Solidity tests pass | Test output reviewed |
| 2026-11-14 | AI coding assistant | Wrote `packages/chain` (SDK-based accounts, hybrid signing, PQC registration, windows) and key generation outside the repo | Secret scan of staged tree before commit |
| 2026-11-14 | AI coding assistant | Bootstrapped + deployed to testnet, relayed owner-signed pause, wrote attack bot (0/32 successes), DRILL_RUNBOOK.md, THREAT_MODEL.md v1 | Owner to review before drill registration |

The build brief is kept in the repo as `QILL_SWITCH_BUILD_PROMPT.md`.

## AI running inside the product

| Component | Role | Can it grant power? |
|---|---|---|
| Mandate compiler (`packages/mandate`) | Turns plain English into mandate JSON from fixed templates; a deterministic validator checks every field | No: the owner must ML-DSA-sign the compiled output |
| Treasury agent (`apps/agent`) | Proposes trades within the active mandate | No: limits are enforced on chain |
| Guardian (`apps/guardian`) | Separate model and prompt; approves or vetoes trades above the soft limit | No: it can only veto. Its signature is needed *in addition to* the mandate |
