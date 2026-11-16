# Running Qill Switch from a clean clone

Everything below runs against the QoreChain testnet (`qorechain-diana`). Commands are from the repo root.

## 0. Prerequisites

- Node.js 22+ and pnpm (`npm i -g pnpm`)
- A QoreChain dashboard login to claim testnet QOR (https://dashboard.qorechain.io/faucet)
- Optional: a free **Gemini** API key (https://aistudio.google.com/apikey) in `.env` as `GEMINI_API_KEY` (copy
  `.env.example` to `.env`), or `ANTHROPIC_API_KEY` for Claude. It powers mandate extraction (`--llm`), agent narration and
  the guardian's review; check it with `pnpm llm:check`. Without it,
  the deterministic paths run and the LLM steps are skipped.

## 1. Build and test (no keys, no network)

```sh
git clone --recurse-submodules https://github.com/CapThunder19/Qill-Switch && cd Qill-Switch
pnpm install
pnpm --filter @qill/contracts build
pnpm test            # 42 Solidity (unit, fuzz, invariant) + 52 TypeScript tests
```

## 2. Use your own keys and deployments

The `deployments/`, `mandates/` and `apps/challenge/public/challenge.json` files in the repo describe **our** testnet
deployment, which only our owner key controls. To run your own:

```sh
rm deployments/*.json mandates/*.json apps/challenge/public/challenge.json
pnpm keys:gen                      # writes keys to ~/.qill/keys (override with QILL_KEY_DIR; never inside the repo)
```

Claim faucet QOR to the printed **funder** `qor1…` address, then:

```sh
pnpm chain:bootstrap               # funder + drill register ML-DSA-87 keys (drill holds only the fee while registering)
pnpm chain:deploy -- --execute     # drill deployment (paused-by-owner posture: pnpm owner pause)
pnpm --filter @qill/chain exec tsx scripts/spike-aa.ts      # relayer, agent smart account, linked agent key, demo vault
```

## 3. The demo (the order used in the video)

```sh
# terminal 1
pnpm guardian

# terminal 2
pnpm qill mandate compile "Trade QTA and QTB on demo-pool. Max 50 per trade, 150 per day, guardian above 20, for 5 days."
pnpm qill mandate submit mandates/<id>.json           # review text vs rules side by side, owner ML-DSA-87 signature
pnpm agent --once --drift-bps 0 --amount 15           # in-mandate trade, no guardian needed
pnpm agent --once --drift-bps 0 --amount 60 --no-guardian   # over the cap: the vault refuses it on chain
pnpm agent --once --drift-bps 0 --amount 30           # above the soft limit: guardian co-signs
pnpm agent --once --drift-bps 0 --amount 60           # guardian vetoes; agent downsizes to the soft limit
pnpm qill stop                                        # STOP
pnpm agent --once                                     # agent refuses: "vault is paused (STOP)"
pnpm qill resume
pnpm --filter @qill/chain exec tsx scripts/setup-qday-test.ts
pnpm qill qday --fleet qday-test                      # Q-Day: freeze, revoke, close, verify
pnpm attack                                           # drill: every attack fails
pnpm attack --target challenge                        # Steal This Agent: every attack fails
```

Dashboard: `pnpm dashboard:build && pnpm dashboard:api`, open http://127.0.0.1:8788 and paste the printed token.
Challenge page: `pnpm --filter @qill/chain exec tsx scripts/setup-challenge.ts && pnpm challenge:dev`.

## 4. Drill day

See [DRILL_RUNBOOK.md](../DRILL_RUNBOOK.md): `pnpm drill:normal-tx` for the normal transaction, `pnpm panic` if
anything looks wrong.
