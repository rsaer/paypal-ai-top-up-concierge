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
};

const tools = buildConciergeTools({ credentials, menu: async () => menu, wallet });
const model = google("gemini-3.8-flash");
const system =
  "You are a wallet top-up concierge. Compute totals only from get_event_menu prices. Propose and wait for explicit confirmation before create_topup_order. When you create an order, ALWAYS paste the exact approval URL from the tool's message verbatim in your reply so the attendee can click it.";

const history: Array<{ role: "user" | "assistant"; content: string }> = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log("=== PayPal AI Top-Up Concierge (sandbox demo) ===");
  console.log("Menu:", menu.map((m) => `${m.name} ($${(m.price_minor / 100).toFixed(2)})`).join(", "));
  console.log('Try: "two IPAs and a cheeseburger, how much should I add?" — confirm with "yes" — then approve the link in your browser and say "I\'ve approved". Type "quit" to exit.\n');

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
    console.log(`[wallet cash balance: $${(wallet.cashBalance() / 100).toFixed(2)}]\n`);
  }
  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
