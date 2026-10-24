import type { Hex } from "viem";
import type { BondRef, ReviewItem } from "@gfh/shared";
import type { PaymentInfo } from "../chain/escrow.ts";

/** Internal transaction state; shared ReviewItem defines its JSON-safe public fields. */
export interface Item extends ReviewItem {
  ref: BondRef;
  agentId?: string;
  feedbackTx?: Hex;
  feedbackConfirmed?: boolean;
  feedbackError?: string;
  payment?: PaymentInfo;
  requirements?: unknown;
  paymentHash?: Hex;
}
export const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export function hydrateItem(raw: string): Item {
  const item = JSON.parse(raw) as Item;
  item.ref.itemNumber = BigInt(item.ref.itemNumber);
  item.ref.githubUserId = BigInt(item.ref.githubUserId);
  item.ref.nonce = BigInt(item.ref.nonce);
  if (item.payment) {
    item.payment.maxAmount = BigInt(item.payment.maxAmount);
    item.payment.salt = BigInt(item.payment.salt);
  }
  return item;
}
