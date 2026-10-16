import { randomUUID } from "node:crypto";
import { z } from "zod";
import { majorToMinor, minorToMajorParts } from "./money.js";
import { hasExplicitConfirmation } from "./confirmation.js";
import { orderToolkit } from "./paypal.js";
import type { Credentials, MenuItem, TopupIntent } from "./types.js";

export type ConciergeWallet = {
  createIntent(orderId: string, amountMinor: number, currency: string): TopupIntent;
  attachCapture(orderId: string, captureId: string): void;
  credit(captureId: string): { credited: boolean };
  cashBalance(): number;
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

export function buildConciergeTools(ctx: ConciergeContext) {
  // Per-conversation replay cache: an agent-framework retry shares a toolCallId, so we return the
  // already-created order instead of hitting PayPal again.
  const orderCache = new Map<
    string,
    { order_id: string; approve_url: string | null; intent_id: string; message: string }
  >();

  return {
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
        currency: z.string().length(3).describe("ISO-4217 currency code, uppercase."),
      }),
      execute: async (
        args: { amount: number; currency: string },
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

        const amountMinor = majorToMinor(args.amount, args.currency);
        const createOrder = orderToolkit(ctx.credentials, key).create_order!;
        const orderResult = await createOrder.execute(
          { currencyCode: args.currency, items: [syntheticLineItem(amountMinor, args.currency)] },
          { toolCallId: key, messages: options?.messages ?? [] },
        );
        const { orderId, approveUrl } = parseOrderResult(String(orderResult));
        const intent = ctx.wallet.createIntent(orderId, amountMinor, args.currency);

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
        "Capture a PayPal order the attendee has already approved, then credit their wallet. Call after the attendee returns from the approval URL.",
      parameters: z.object({ order_id: z.string().min(1) }),
      execute: async (args: { order_id: string }) => {
        const tools = orderToolkit(ctx.credentials, randomUUID());
        const captureResult = await tools.pay_order!.execute(
          { id: args.order_id },
          { toolCallId: randomUUID(), messages: [] },
        );
        let { captureId } = parseCaptureResult(String(captureResult));
        if (!captureId) {
          // Already captured (a retried/idempotent capture): fetch the existing capture from the order.
          const orderResult = await tools.get_order!.execute(
            { id: args.order_id },
            { toolCallId: randomUUID(), messages: [] },
          );
          captureId = parseCaptureResult(String(orderResult)).captureId;
        }
        if (!captureId) return { error: "The capture did not return a capture id." };

        ctx.wallet.attachCapture(args.order_id, captureId);
        const credited = ctx.wallet.credit(captureId);
        return { capture_id: captureId, credited: credited.credited };
      },
    },
  };
}
