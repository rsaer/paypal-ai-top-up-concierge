# Architecture notes

This repository is a **standalone extract** of the reusable core of a production feature. The full implementation lives in a private monorepo (Medusa v2 + Next.js + Expo), where the concierge runs as a server-orchestrated route with real wallets, tenants, and Postgres-backed ledgers. This file maps the extract back to that production code so reviewers can see what's real vs. simplified for the demo.

## Production → extract mapping

| Concern | Production (private) | This extract |
|---|---|---|
| AI agent | `generateText` + Gemini (`@ai-sdk/google`) in a Medusa API route | same, in `demo/demo.ts` |
| Tools | `get_spend_summary`, `get_event_menu`, `create_topup_order`, `capture_topup_order` in `paypal-payment/concierge.ts` | `src/concierge.ts` (identical logic) |
| Proactive suggestion | `suggestTopupAmount` reads the wallet's own ledger (`WalletModuleService.getSpendSummary`), clamped to `$10`–`$100`, `$25` default for no history | `src/concierge.ts` (`suggestTopupAmount`), seeded from a simulated in-memory spend history in `demo/demo.ts` |
| Confirmation gate | `hasExplicitConfirmation` in the `create_topup_order` tool | `src/confirmation.ts` (identical) |
| Menu pricing | Medusa storefront catalog (products + variants + prices, tenant-scoped) | an in-memory `menu` array |
| PayPal calls | `@paypal/agent-toolkit` (`create_order`/`pay_order`/`get_order`), per-order `request_id` idempotency | `src/paypal.ts` (identical) |
| Wallet + ledger | Medusa `wallet` module: `postTransaction` + `getOrCreateSystemAccount`, Postgres append-only trigger, `paypal_clearing` system account | `src/ledger.ts` (in-memory, same invariants) |
| Idempotency | `paypal:{captureId}:topup` idempotency key + intent-status check | same key, enforced in `Ledger.post` |

## The invariants that carry over

1. **Money is integer minor units + ISO code** — never floats, never mixed currencies in one wallet.
2. **The ledger is append-only double-entry** — corrections are new reversing entries; cached balances are rebuildable.
3. **Every value-moving call is idempotent** — `paypal:{captureId}:topup`; a redelivered webhook or a retried tool call can never double-credit.
4. **Confirmation is enforced, not prompted** — `create_topup_order` checks the conversation itself.
5. **Card data never reaches the backend** — PayPal's hosted approval step handles it; only PayPal order/capture IDs flow back.
6. **The server never trusts the model for a fact it already knows.** In testing, Gemini occasionally omitted required tool arguments (`currency` on `create_topup_order`, `order_id` on `capture_topup_order`) entirely. Both now default server-side — `currency` to this sandbox's only supported currency, `order_id` to the conversation's own most-recently-created order — rather than letting a missing model argument silently fail a money-moving call.

## What's simplified here (and why)

- **In-memory wallet/ledger** instead of Postgres — so `npm install && npm run demo` works with zero infrastructure.
- **Hardcoded menu** instead of a live catalog — the `menu` function is the seam; swap it for a DB query in production.
- **Sandbox-only, USD-only** — the Agent Toolkit's `create_order` enum is USD-only; the demo is intentionally sandbox-scoped.
- **`get_merchant_insights`** is present in the toolkit but returns "not supported in sandbox"; `list_transactions` is the usable reporting surface.

## Dependency security

`@paypal/agent-toolkit` bundles its own older copies of `ai` (v4, for a LangChain/React adapter this repo never imports — only the `/ai-sdk` subpath is used), `@langchain/core`, `langsmith`, `mathjs`, `jsondiffpatch`, and `uuid`. GitHub's Dependabot flagged known advisories in all of them. `package.json`'s `overrides` field forces each one up to its earliest patched release, scoped specifically to `@paypal/agent-toolkit`'s own dependency subtree so it can't collide with `@ai-sdk/google`'s separate, newer copies of the same package names (an earlier, unscoped attempt at this broke `@ai-sdk/google` outright — scoping fixed it). One advisory remains unresolved: the nested `ai@4.x` copy has a file-upload filetype-whitelist bypass with no patched 4.x release available upstream; this repo never calls any file-upload tool, so it's a known, accepted residual rather than something actively exploitable here.

## Production integration (reference)

In the full backend, the concierge is `POST /portal/wallets/:id/paypal-concierge`, authenticated as the attendee's own customer, with the organizer's PayPal credentials sealed at rest (AES-256-GCM) and unsealed server-side. A parallel `paypal-payment` module owns `paypal_connection`, `paypal_topup_intent`, and `paypal_webhook_event` tables, and credits the wallet through the same `postTransaction` seam Square uses. There's also an organizer-facing **PayPal Insights** admin surface (Gemini + the toolkit's `list_transactions`), scoped to the asking organizer's own account.
