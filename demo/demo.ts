import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { generateText, stepCountIs } from "ai";
import { google } from "@ai-sdk/google";
import { buildConciergeTools, type ConciergeWallet } from "../src/concierge.js";
import { Ledger } from "../src/ledger.js";
import type { Credentials, MenuItem, TopupIntent } from "../src/types.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

const credentials: Credentials = {
  client_id: env("PAYPAL_CLIENT_ID"),
  client_secret: env("PAYPAL_CLIENT_SECRET"),
  merchant_id: env("PAYPAL_MERCHANT_ID"),
};

const menu: MenuItem[] = [
  { name: "IPA Beer", price_minor: 700, currency: "USD" },
  { name: "Cheeseburger", price_minor: 1500, currency: "USD" },
  { name: "Nachos", price_minor: 900, currency: "USD" },
];

const ledger = new Ledger();
const intentsByOrder = new Map<string, TopupIntent>();
const intentsByCapture = new Map<string, TopupIntent>();

// Simulated event state for the proactive-suggestion demo. In production this is the event's own
// scheduled end time and the attendee's real spend history; here it's seeded so the demo is
// runnable with zero infrastructure. Set DEMO_FRESH_WALLET=true to see the first-timer default
// instead (no prior spend this event).
const EVENT_ENDS_AT = new Date(Date.now() + 150 * 60_000); // event ends in 2.5 hours
if (process.env.DEMO_FRESH_WALLET !== "true") {
  // An earlier top-up (40 min ago) followed by $18 of spend (30 min ago) — the same spend figure
  // verified end-to-end against the sandbox, leaving a believable $12 balance before the concierge
  // opens.
  ledger.post(
    "topup",
    "demo:seed:topup:1",
    [
      { account_id: "seed_source", direction: "debit", amount_minor: 3000, currency: "USD" },
      { account_id: "wallet", direction: "credit", amount_minor: 3000, currency: "USD" },
    ],
    new Date(Date.now() - 40 * 60_000),
  );
  ledger.post(
    "sale",
    "demo:seed:sale:1",
    [
      { account_id: "wallet", direction: "debit", amount_minor: 1800, currency: "USD" },
      { account_id: "bar_revenue", direction: "credit", amount_minor: 1800, currency: "USD" },
    ],
    new Date(Date.now() - 30 * 60_000),
  );
}

const wallet: ConciergeWallet = {
  createIntent(orderId, amountMinor, currency) {
    const intent: TopupIntent = {
      id: randomUUID(),
      order_id: orderId,
      amount_minor: amountMinor,
      currency,
      status: "pending",
    };
    intentsByOrder.set(orderId, intent);
    return intent;
  },
  attachCapture(orderId, captureId) {
    const intent = intentsByOrder.get(orderId);
    if (intent) intentsByCapture.set(captureId, intent);
  },
  credit(captureId) {
    const intent = intentsByCapture.get(captureId);
    if (!intent || intent.status === "credited") return { credited: false };
    ledger.post("topup", `paypal:${captureId}:topup`, [
      { account_id: "paypal_clearing", direction: "debit", amount_minor: intent.amount_minor, currency: intent.currency },
      { account_id: "wallet", direction: "credit", amount_minor: intent.amount_minor, currency: intent.currency },
    ]);
    intent.status = "credited";
    return { credited: true };
  },
  cashBalance() {
    return ledger.balance("wallet");
  },
  spendSummary() {
    return {
      spent_minor: ledger.debitTotal("wallet"),
      currency: "USD",
      first_spend_at: ledger.firstDebitAt("wallet"),
      event_ends_at: EVENT_ENDS_AT,
    };
  },
};

const tools = buildConciergeTools({ credentials, menu: async () => menu, wallet });
const model = google("gemini-3.8-flash");
const system =
  "You are a wallet top-up concierge. As your very first message, call get_spend_summary and open with a friendly, proactive suggestion based on the attendee's own spend so far (e.g. \"You've spent $18 so far tonight — want me to add $70 to cover the rest of the night?\"). A suggestion is a conversation starter, not an order. If the attendee then names specific items, that named-items total REPLACES the earlier suggestion — propose only that one total, never ask the attendee to choose between two numbers. Compute any total only from get_event_menu prices or the suggested amount from get_spend_summary — never invent a price or a spend figure. Propose a single clear total and wait for explicit confirmation before create_topup_order. When you create an order, ALWAYS paste the exact approval URL from the tool's message verbatim in your reply so the attendee can click it.";

/**
 * Pull the approval URL straight out of the tool-call result, the same way the production route
 * (`extractOutcome` in `paypal-concierge/route.ts`) does — never trust the model's prose to restate
 * a link correctly. Gemini sometimes garbles or omits the URL in its text reply even when the tool
 * itself returned one.
 */
function extractApproveUrl(steps: unknown): string | null {
  const stepList = Array.isArray(steps) ? steps : [];
  for (const step of stepList as Array<{ toolResults?: Array<{ output?: Record<string, unknown>; result?: Record<string, unknown> }> }>) {
    for (const toolResult of step.toolResults ?? []) {
      const out = toolResult.output ?? toolResult.result; // ai@7 uses `output`; ai@4 used `result`
      if (out && typeof out.approve_url === "string") return out.approve_url;
    }
  }
  return null;
}

const history: Array<{ role: "user" | "assistant"; content: string }> = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log("=== PayPal AI Top-Up Concierge (sandbox demo) ===");
  console.log("Menu:", menu.map((m) => `${m.name} ($${(m.price_minor / 100).toFixed(2)})`).join(", "));
  if (process.env.DEMO_FRESH_WALLET === "true") {
    console.log("Scenario: a fresh wallet with no prior spend this event.");
  } else {
    console.log(`Scenario: $18.00 spent 30 minutes ago, $12.00 left, event ends in ${Math.round((EVENT_ENDS_AT.getTime() - Date.now()) / 60000)} minutes.`);
  }
  console.log('Say "hi" and the concierge will open with a proactive suggestion based on that history.');
  console.log('Or try: "two IPAs and a cheeseburger, how much should I add?" — confirm with "yes" — then approve the link in your browser and say "I\'ve approved". Type "quit" to exit.\n');

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "quit" || line === "exit") break;

    history.push({ role: "user", content: line });
    const result = await generateText({
      model,
      system,
      tools: tools as never,
      stopWhen: stepCountIs(8),
      messages: history,
    } as never);
    history.push({ role: "assistant", content: result.text });
    console.log(`\nconcierge> ${result.text}`);
    const approveUrl = extractApproveUrl((result as unknown as { steps?: unknown }).steps);
    if (approveUrl) console.log(`[approval link: ${approveUrl}]`);
    console.log(`[wallet cash balance: $${(wallet.cashBalance() / 100).toFixed(2)}]\n`);
  }
  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
