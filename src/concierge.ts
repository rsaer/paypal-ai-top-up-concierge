import { randomUUID } from "node:crypto";
import { z } from "zod";
import { majorToMinor, minorToMajorParts } from "./money.js";
import { hasExplicitConfirmation } from "./confirmation.js";
import { orderToolkit } from "./paypal.js";
import type { Credentials, MenuItem, TopupIntent } from "./types.js";

export type SpendSummary = {
  spent_minor: number;
  currency: string;
  /** When the attendee's first spend this event was posted, or null if they have none yet. */
  first_spend_at: Date | null;
  /** The event's scheduled end time, or null if unknown. */
  event_ends_at: Date | null;
};

export type ConciergeWallet = {
  createIntent(orderId: string, amountMinor: number, currency: string): TopupIntent;
  attachCapture(orderId: string, captureId: string): void;
  credit(captureId: string): { credited: boolean };
  cashBalance(): number;
  spendSummary(): SpendSummary;
};

export type ConciergeContext = {
  credentials: Credentials;
  menu: () => Promise<MenuItem[]>;
  wallet: ConciergeWallet;
};

/** A wallet top-up is a single-amount operation, modeled as one synthetic line item for PayPal. */
function syntheticLineItem(amountMinor: number, currency: string) {
  const { value, display } = minorToMajorParts(amountMinor, currency);
  return { name: "Event Wallet Top-Up", quantity: 1, unitPrice: display, itemCost: value, itemTotal: value };
}

function parseOrderResult(result: string): { orderId: string; approveUrl: string | null } {
  const parsed = JSON.parse(result) as { id?: string; links?: Array<{ rel?: string; href?: string }> };
  const approveUrl = parsed.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { orderId: parsed.id ?? "", approveUrl };
}

function parseCaptureResult(result: string): { captureId: string | null; status: string | null } {
  const parsed = JSON.parse(result) as {
    status?: string;
    response?: { status?: string; purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string; status?: string }> } }> };
    purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string; status?: string }> } }>;
  };
  const order = parsed.response ?? parsed;
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return { captureId: capture?.id ?? null, status: capture?.status ?? order.status ?? null };
}

// Suggestion constants (integer minor units + minutes). Kept deliberately small and clamped so a
// single extreme transaction can never produce a runaway or negligible suggestion.
const MIN_SUGGESTION_MINOR = 1000; // $10
const MAX_SUGGESTION_MINOR = 10000; // $100
const DEFAULT_SUGGESTION_MINOR = 2500; // $25 — the flat default for a first-time attendee
const FRIENDLY_INCREMENT_MINOR = 500; // $5 rounding
const MIN_ELAPSED_MINUTES = 5; // below this, fall back to the default instead of extrapolating

export type SuggestionInput = SpendSummary & { now?: Date };

export type SuggestionResult = {
  /** Gross spend so far, major units. */
  spent_so_far: number;
  currency: string;
  elapsed_minutes: number;
  /** Clamped, rounded suggestion, major units. */
  suggested_amount: number;
  has_history: boolean;
};

/**
 * Derives a suggested top-up from the attendee's own spend rate, extrapolated to the event's end
 * time, clamped to [MIN, MAX] and rounded to a friendly increment. A first-time attendee (no prior
 * spend) or a sub-threshold elapsed time returns the flat default — never a figure computed from
 * zero or near-zero data. Identical logic to the production `paypal-payment/concierge.ts`.
 */
export function suggestTopupAmount(input: SuggestionInput): SuggestionResult {
  const now = input.now ?? new Date();
  const spent_so_far = minorToMajorParts(input.spent_minor, input.currency).value;

  if (!input.first_spend_at || !input.event_ends_at) {
    return {
      spent_so_far,
      currency: input.currency,
      elapsed_minutes: 0,
      suggested_amount: minorToMajorParts(DEFAULT_SUGGESTION_MINOR, input.currency).value,
      has_history: false,
    };
  }

  const elapsedMinutes = (now.getTime() - input.first_spend_at.getTime()) / 60000;
  const remainingMinutes = (input.event_ends_at.getTime() - now.getTime()) / 60000;

  if (elapsedMinutes < MIN_ELAPSED_MINUTES || remainingMinutes <= 0) {
    return {
      spent_so_far,
      currency: input.currency,
      elapsed_minutes: Math.round(elapsedMinutes),
      suggested_amount: minorToMajorParts(DEFAULT_SUGGESTION_MINOR, input.currency).value,
      has_history: true,
    };
  }

  let suggestedMinor = (input.spent_minor / elapsedMinutes) * remainingMinutes;
  suggestedMinor = Math.min(Math.max(suggestedMinor, MIN_SUGGESTION_MINOR), MAX_SUGGESTION_MINOR);
  suggestedMinor = Math.round(suggestedMinor / FRIENDLY_INCREMENT_MINOR) * FRIENDLY_INCREMENT_MINOR;

  return {
    spent_so_far,
    currency: input.currency,
    elapsed_minutes: Math.round(elapsedMinutes),
    suggested_amount: minorToMajorParts(suggestedMinor, input.currency).value,
    has_history: true,
  };
}

export function buildConciergeTools(ctx: ConciergeContext) {
  // Per-conversation replay cache: an agent-framework retry shares a toolCallId, so we return the
  // already-created order instead of hitting PayPal again.
  const orderCache = new Map<
    string,
    { order_id: string; approve_url: string | null; intent_id: string; message: string }
  >();

  // The model is sometimes unreliable about echoing `order_id` back for capture (it has been
  // observed calling the tool with no arguments at all). The server already knows which order it
  // just created, so track it as a fallback rather than trusting the model to get a required
  // argument right every time.
  let lastCreatedOrderId: string | null = null;

  return {
    get_spend_summary: {
      description:
        "Summarize the authenticated attendee's own spend so far for this event and suggest a top-up amount, derived from their real ledger history (never invented) and clamped to a sane range; a first-time attendee gets a flat default. Read-only — it never creates an order.",
      parameters: z.object({}),
      execute: async () => {
        const summary = ctx.wallet.spendSummary();
        const suggestion = suggestTopupAmount(summary);
        return {
          spent_so_far: suggestion.spent_so_far,
          currency: suggestion.currency,
          elapsed_minutes: suggestion.elapsed_minutes,
          suggested_amount: suggestion.suggested_amount,
          has_history: suggestion.has_history,
        };
      },
    },

    get_event_menu: {
      description:
        "Return the event's purchasable items and their real prices (major units, e.g. 7 for seven dollars). Use this to compute a top-up total from the items the attendee names. Never invent a price.",
      parameters: z.object({}),
      execute: async () => {
        const items = await ctx.menu();
        return {
          items: items.map((item) => ({
            name: item.name,
            price: minorToMajorParts(item.price_minor, item.currency).value,
            currency: item.currency,
          })),
        };
      },
    },

    create_topup_order: {
      description:
        "Create a PayPal order for a wallet top-up of a confirmed amount (major units, e.g. 25 for $25) and return an approval URL. Only call AFTER the attendee has explicitly confirmed the exact amount.",
      parameters: z.object({
        amount: z.number().positive().max(1_000_000).describe("The top-up amount in major units, e.g. 25 for $25."),
        currency: z
          .string()
          .length(3)
          .optional()
          .describe("ISO-4217 currency code, uppercase (e.g. USD). This sandbox is USD-only; omit it if unsure."),
      }),
      execute: async (
        args: { amount: number; currency?: string },
        options?: { toolCallId?: string; messages?: Array<{ role: string; content?: unknown }> },
      ) => {
        const key = options?.toolCallId ?? randomUUID();
        if (!hasExplicitConfirmation(options?.messages ?? [])) {
          return {
            error:
              "The attendee has not explicitly confirmed the amount. Propose the total, then wait for their clear confirmation before creating a PayPal order.",
          };
        }
        const cached = orderCache.get(key);
        if (cached) return { ...cached };

        // The model occasionally omits `currency` even though it's declared — never let a missing
        // model argument silently fail order creation when the server already knows the only
        // currency this sandbox supports.
        const currency = (args.currency ?? "USD").toUpperCase();
        const amountMinor = majorToMinor(args.amount, currency);
        const createOrder = orderToolkit(ctx.credentials, key).create_order!;
        const orderResult = await createOrder.execute(
          { currencyCode: currency, items: [syntheticLineItem(amountMinor, currency)] },
          { toolCallId: key, messages: options?.messages ?? [] },
        );
        const { orderId, approveUrl } = parseOrderResult(String(orderResult));
        const intent = ctx.wallet.createIntent(orderId, amountMinor, currency);
        lastCreatedOrderId = orderId;

        const result = {
          order_id: orderId,
          approve_url: approveUrl,
          intent_id: intent.id,
          message: approveUrl
            ? `PayPal order created. The attendee must open this approval URL to pay: ${approveUrl}`
            : "PayPal order created.",
        };
        orderCache.set(key, result);
        return result;
      },
    },

    capture_topup_order: {
      description:
        "Capture a PayPal order the attendee has already approved, then credit their wallet. Call after the attendee returns from the approval URL. order_id may be omitted to capture the most recently created order in this conversation.",
      parameters: z.object({ order_id: z.string().min(1).optional() }),
      execute: async (args: { order_id?: string }) => {
        // The model has been observed calling this tool with no arguments at all; fall back to the
        // order this conversation most recently created rather than failing outright.
        const orderId = args.order_id ?? lastCreatedOrderId;
        if (!orderId) {
          return { error: "No PayPal order has been created yet in this conversation to capture." };
        }
        const tools = orderToolkit(ctx.credentials, randomUUID());
        const captureResult = await tools.pay_order!.execute(
          { id: orderId },
          { toolCallId: randomUUID(), messages: [] },
        );
        let { captureId } = parseCaptureResult(String(captureResult));
        if (!captureId) {
          // Already captured (a retried/idempotent capture): fetch the existing capture from the order.
          const orderResult = await tools.get_order!.execute(
            { id: orderId },
            { toolCallId: randomUUID(), messages: [] },
          );
          captureId = parseCaptureResult(String(orderResult)).captureId;
        }
        if (!captureId) return { error: "The capture did not return a capture id." };

        ctx.wallet.attachCapture(orderId, captureId);
        const credited = ctx.wallet.credit(captureId);
        return { capture_id: captureId, credited: credited.credited };
      },
    },
  };
}
