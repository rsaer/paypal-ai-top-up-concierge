# PayPal AI Top-Up Concierge

An **AI concierge that tops up an event wallet through PayPal** — built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

A wristband-wearing attendee chats with the concierge instead of typing a card number. The agent looks up real menu prices, proposes a total, waits for explicit confirmation, then creates a PayPal order (sandbox) and returns a hosted approval link. Once the attendee approves, the order is captured and the wallet is credited through an append-only double-entry ledger with idempotency guarantees.

This repository is a **standalone extract** of the reusable core — the agent, the confirmation gate, the money rules, and the ledger — decoupled from the production Medusa backend it was built against (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## What's in the box

| Piece | Where | Why it matters |
|---|---|---|
| AI concierge | `src/concierge.ts` | Three tools (`get_event_menu`, `create_topup_order`, `capture_topup_order`) driven by Gemini via the Vercel AI SDK |
| Confirmation gate | `src/confirmation.ts` | An order is never created until the attendee explicitly confirms the amount — enforced in the tool, not just the prompt |
| Money rules | `src/money.ts` | All amounts are integer minor units (cents); conversion to major units happens in one place |
| Double-entry ledger | `src/ledger.ts` | Balanced entries + idempotent replay (one credit per `paypal:{captureId}:topup` key) |
| PayPal integration | `src/paypal.ts` | PayPal's official Agent Toolkit, scoped to order create/capture/get, with per-order `request_id` idempotency |
| Demo | `demo/demo.ts` | An interactive CLI that runs the whole flow against the PayPal sandbox |

## Prerequisites

- Node.js **20+**
- A **PayPal developer account** with a sandbox REST app (Client ID + Secret + Merchant ID) — free, from [developer.paypal.com](https://developer.paypal.com)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com) (free tier is fine)

## Setup

```bash
git clone <this repo>
cd paypal-ai-top-up-concierge
cp .env.example .env
# fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MERCHANT_ID, GOOGLE_GENERATIVE_AI_API_KEY
npm install
```

## Run the demo

```bash
npm run demo
```

Then try:

```
you> two IPAs and a cheeseburger, how much should I add?
concierge> … That'll be $29.00. Would you like me to create the order?
you> yes
concierge> … Open this approval link: https://www.sandbox.paypal.com/checkoutnow?token=…
# open the link in a browser, log in with a sandbox *personal* (buyer) account, approve
you> I've approved
concierge> … captured and credited.
[wallet cash balance: $29.00]
```

**Tip:** to approve the order you need a sandbox *personal* account. In the PayPal Developer Dashboard, go to **Testing Tools → Sandbox Accounts** and use the `@personal.example.com` account's credentials to log in at the approval link.

## How it works

1. The `get_event_menu` tool returns the event's real prices (never invented by the model).
2. `create_topup_order` refuses to fire until the attendee's latest message is an explicit confirmation, then calls PayPal's `create_order` through the Agent Toolkit and returns the hosted approval URL.
3. After the buyer approves, `capture_topup_order` captures the order and credits the wallet via the ledger: `paypal_clearing` (debit) → wallet cash (credit), keyed `paypal:{captureId}:topup` so a redelivered capture can never double-credit.

The Agent Toolkit's `create_order` only supports **USD** in sandbox, so the demo menu is priced in USD.

## Project structure

```
.
├── src/
│   ├── concierge.ts       # the agent's tools
│   ├── confirmation.ts    # the confirmation gate
│   ├── money.ts           # minor/major unit conversion + validation
│   ├── ledger.ts          # append-only double-entry ledger + idempotency
│   ├── paypal.ts          # PayPal Agent Toolkit wrapper (create/capture/get)
│   ├── types.ts           # shared types
│   └── index.ts           # public exports
├── demo/
│   └── demo.ts            # interactive CLI demo
├── docs/
│   ├── ARCHITECTURE.md    # how this maps to the production Medusa backend
│   └── DEVPOST.md         # hackathon submission text
├── LICENSE                # MIT
└── .env.example
```

## License

MIT — see [LICENSE](LICENSE).
