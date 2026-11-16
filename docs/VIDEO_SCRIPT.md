# 3-minute video script

Target length 2:50. Screen: terminal on the left, dashboard (http://127.0.0.1:8788) on the right. Before recording, start
`pnpm guardian` and `pnpm dashboard:api`, and have a fresh mandate compiled so the submit step is quick.

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Featured image, then the dashboard | "AI agents are getting wallets. When Q-Day comes, every classical key they hold can be forged. Qill Switch makes sure a stolen classical key can never loosen what an agent is allowed to do." |
| 0:15–0:40 | `pnpm qill mandate compile "…"`: the side-by-side view | "The owner writes a mandate in plain English. It's compiled into on-chain rules: caps, a daily limit, a pool allowlist, an expiry, and a smart-account rule that lets the agent's key call one function only, `vault.trade`. A strict validator rejects anything vague or excessive." (Optionally show a rejection: "60 > 30 days".) |
| 0:40–0:55 | `qill mandate submit`: signing and relaying | "The owner signs the mandate with an ML-DSA-87 key. QoreChain's `pqcVerify` precompile checks that signature inside the vault, and it's relayed through an EVM window scoped to the vault only, then closed." |
| 0:55–1:20 | `pnpm agent --once --amount 15`, then the dashboard activity | "The agent trades inside the mandate through its smart account. Every log line cites the mandate ID and every cap that applied." |
| 1:20–1:40 | `--amount 60 --no-guardian`, then `--amount 30` | "Over the cap? The vault refuses it on chain. Above the soft limit, an independent guardian service with its own ML-DSA key has to co-sign, here it approves." |
| 1:40–1:55 | `--amount 60` (veto), dashboard shows "guardian vetoed" | "And it can veto. The guardian can only take power away, never grant it." |
| 1:55–2:15 | Dashboard STOP button, then `pnpm agent --once` | "STOP is one post-quantum signature. The agent fails closed." Then click Resume. |
| 2:15–2:35 | `pnpm qill qday --fleet qday-test` final state table | "Q-Day: one command freezes every vault, revokes every agent key and closes every EVM window, then verifies all of it on chain." |
| 2:35–2:50 | `pnpm attack` scoreboard, then the Steal This Agent page | "We published the agent's key and a funded account's key. 71 attacks with those keys: zero successes. Try it yourself: Steal This Agent." |

**Checklist before recording**
- Agent smart account rule is `1 uqor` per execution and per day (`pnpm qill rules show`).
- Demo vault is not paused (`pnpm qill status`).
- Relayer has at least 3 QOR (`pnpm qill status`); each demo step costs about 0.05–0.1 QOR.
- The guardian rate limit allows at most 3 approvals per hour and 30 s between them. Space the guardian steps out, or
  record them first.
