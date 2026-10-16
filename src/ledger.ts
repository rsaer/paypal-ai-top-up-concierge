import { randomUUID } from "node:crypto";
import { assertSafeInteger } from "./money.js";

export type LedgerEntryInput = {
  account_id: string;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
};

export type PostedTransaction = {
  id: string;
  type: string;
  idempotency_key: string;
  entries: LedgerEntryInput[];
  posted_at: Date;
};

/**
 * A minimal append-only double-entry ledger with idempotent replay. In production this is backed by
 * Postgres with an append-only trigger and per-event tenant isolation; the demo holds the same
 * invariants (balanced entries, one credit per idempotency key) in memory.
 */
export class Ledger {
  private transactions = new Map<string, PostedTransaction>();
  private balances = new Map<string, number>();

  post(type: string, idempotencyKey: string, entries: LedgerEntryInput[], postedAt: Date = new Date()): PostedTransaction {
    const existing = this.transactions.get(idempotencyKey);
    if (existing) return existing; // idempotent replay returns the original

    if (entries.length < 2) throw new Error("A transaction needs at least one debit and one credit");
    const currency = entries[0]!.currency;
    let debits = 0;
    let credits = 0;
    for (const entry of entries) {
      assertSafeInteger(entry.amount_minor, "entry amount");
      if (entry.amount_minor <= 0) throw new Error("Entry amounts must be positive");
      if (entry.currency !== currency) {
        throw new Error(`Currency mismatch: ${currency} and ${entry.currency}`);
      }
      if (entry.direction === "debit") debits += entry.amount_minor;
      else credits += entry.amount_minor;
    }
    if (debits !== credits) throw new Error("Transaction entries must be balanced");

    for (const entry of entries) {
      const delta = entry.direction === "debit" ? -entry.amount_minor : entry.amount_minor;
      this.balances.set(entry.account_id, (this.balances.get(entry.account_id) ?? 0) + delta);
    }

    const txn: PostedTransaction = { id: randomUUID(), type, idempotency_key: idempotencyKey, entries, posted_at: postedAt };
    this.transactions.set(idempotencyKey, txn);
    return txn;
  }

  balance(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  /** Sum of all debit entries ever posted against an account — the basis for a spend summary. */
  debitTotal(accountId: string): number {
    let total = 0;
    for (const txn of this.transactions.values()) {
      for (const entry of txn.entries) {
        if (entry.account_id === accountId && entry.direction === "debit") total += entry.amount_minor;
      }
    }
    return total;
  }

  /** Earliest posting time of a debit entry against an account, or null if there has never been one. */
  firstDebitAt(accountId: string): Date | null {
    let earliest: Date | null = null;
    for (const txn of this.transactions.values()) {
      const isDebit = txn.entries.some((entry) => entry.account_id === accountId && entry.direction === "debit");
      if (isDebit && (!earliest || txn.posted_at < earliest)) earliest = txn.posted_at;
    }
    return earliest;
  }
}
