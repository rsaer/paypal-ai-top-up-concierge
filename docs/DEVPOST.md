# Devpost submission — draft

> Paste these fields into the Devpost submission form. Title and tagline can be tweaked.

## Title

**Concierge** — a wristband-wallet top-up that runs on PayPal, with an AI that only moves money after you say "yes".

*(alt: "PayPal AI Top-Up Concierge")*

## Tagline

Top up an event wristband by talking to an AI — amounts come from real menu prices, money moves only through PayPal, and a double-entry ledger makes double-charging impossible.

## Description (features & functionality)

Concierge replaces a card-entry form with a conversation. It's built for **closed-loop events** (festivals, venues) where attendees load value onto an NFC wristband and spend it on food and drink without ever carrying a card.

What it does:

- **Natural-language top-up.** An attendee says "two IPAs and a cheeseburger" and the concierge computes the total from the event's *real* menu prices — it can never invent a price.
- **Proactive, personalized suggestion.** Before the attendee names anything, the concierge reads their *own* spend history for this event and opens with a suggested top-up ("You've spent $18 — want me to add $70 for the rest of the night?"). A first-timer gets a sensible configured default instead of a made-up number.
- **Explicit-confirmation guard.** The concierge proposes a total and *will not create a PayPal order* until the attendee has explicitly confirmed it in the conversation. (This is enforced inside the tool, not left to the model's discretion.)
- **PayPal-hosted approval.** The order is created through PayPal's official **Agent Toolkit**; approval happens entirely on PayPal's own page, so card data never touches our backend.
- **Idempotent, append-only accounting.** When the order is captured, the wallet is credited through a double-entry ledger (`paypal_clearing` → wallet) keyed by the capture ID — a redelivered webhook or a retried agent call can never double-charge.
- **Organizer insights (bonus).** A separate admin surface lets an organizer ask about their PayPal sales in plain language, scoped strictly to their own account.

The result: a payment experience where the AI is genuinely responsible — it reads real data, confirms before acting, and every cent is provably accounted for.

## How it works (the flow)

1. `get_event_menu` → real menu prices.
2. `create_topup_order` → confirmation gate → PayPal `create_order` → hosted approval URL.
3. Buyer approves at PayPal.
4. `capture_topup_order` → PayPal `capture` → double-entry ledger credit.

## AI tools used — and how

- **Gemini (`gemini-3.8-flash`)** via the **Vercel AI SDK** (`@ai-sdk/google`) is the reasoning agent: it interprets the attendee's request, chooses which tool to call, and relays results in plain language.
- **Tool-calling / function-calling** is how the agent is constrained: it can only act through three tools, and the `create_topup_order` tool *itself* re-checks the conversation for an explicit confirmation before touching PayPal.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) is the PayPal integration: `create_order`, `pay_order` (capture), and `get_order`, with a per-order `request_id` used as PayPal's idempotency key.
- A custom **`get_event_menu` tool** grounds the model in real pricing data, and a second agent (the insights assistant) uses the toolkit's `list_transactions` to answer merchant questions.
- A custom **`get_spend_summary` tool** reasons over the attendee's own ledger history (spend rate extrapolated to the event's end, clamped to a sane range) to power the proactive suggestion — personalization from the attendee's real data, never a model guess.

## Try it yourself

```bash
npm install
cp .env.example .env   # add PayPal sandbox client ID/secret/merchant ID + a Gemini key
npm run demo
```

Full setup/run instructions are in the [README](README.md).

## Demo video (≤3 min) outline

1. (0:00) One-liner + the wristband/event framing.
2. (0:15) The concierge opens with a proactive suggestion from the attendee's own spend history.
3. (0:30) Live: "two IPAs and a cheeseburger" → concierge proposes $29.00, **no order created**.
4. (1:00) "yes" → real PayPal order → approval link.
5. (1:30) Approve in PayPal as the sandbox buyer.
6. (2:00) "I've approved" → capture → wallet balance updates.
7. (2:30) Quick shot of the organizer **PayPal Insights** chat + the `paypal:{captureId}:topup` ledger entry (no double-charge).

## Judge-facing notes (not for the public text)

- The production version runs inside a Medusa v2 backend (see `docs/ARCHITECTURE.md`); this repo is the self-contained runnable core.
- The PayPal Agent Toolkit's `create_order` is USD-only in sandbox, which is why the demo menu is priced in USD.
