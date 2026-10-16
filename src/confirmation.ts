/**
 * The confirmation gate: an order is never created until the attendee has explicitly confirmed the
 * proposed amount. This is enforced inside the create_topup_order tool, not just in the prompt.
 */

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? (part as { text: string }).text : "",
      )
      .join(" ");
  }
  return "";
}

export function isExplicitConfirmation(text: string): boolean {
  return /^(yes|yeah|yep|ok|okay|confirm|confirmed|correct|sounds good|that works|go ahead|approved|that's right|i agree|agreed|yes please|proceed|please proceed)\b/i.test(
    text.trim(),
  );
}

export function hasExplicitConfirmation(
  messages: Array<{ role: string; content?: unknown }>,
): boolean {
  const userMessages = messages.filter((message) => message.role === "user");
  const last = userMessages[userMessages.length - 1];
  return !!last && isExplicitConfirmation(messageText(last.content));
}
