import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { Credentials } from "./types.js";

export type ToolkitTool = { execute: (args: unknown, options?: unknown) => Promise<unknown> };

/**
 * Builds a PayPal toolkit scoped to order create/capture/get, bound to the organizer's own
 * sandbox credentials. A fresh toolkit is created per order with `request_id` set to the tool-call
 * id, so PayPal's PayPal-Request-Id is deterministic and a retried tool call dedupes to the same
 * order instead of charging twice.
 */
export function orderToolkit(credentials: Credentials, requestId: string): Record<string, ToolkitTool> {
  const toolkit = new PayPalAgentToolkit({
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    configuration: {
      actions: { orders: { create: true, capture: true, get: true } },
      context: { sandbox: true, merchant_id: credentials.merchant_id, request_id: requestId },
    },
  });
  return toolkit.getTools() as unknown as Record<string, ToolkitTool>;
}
