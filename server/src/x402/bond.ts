// x402 v2 envelope for the GFH-aware auth-capture adapter.
// Contribution binding is a GFH extension; lifecycle settlement runs through our operator.
import { BASE_SEPOLIA } from "@gfh/shared";
import type { PaymentInfo } from "../chain/escrow.ts";

export const PAYMENT_HEADERS = {
  required: "PAYMENT-REQUIRED", signature: "PAYMENT-SIGNATURE", response: "PAYMENT-RESPONSE",
} as const;

export function paymentRequirements(info: PaymentInfo, amount: bigint, resource: string) {
  if (amount <= 0n || amount !== info.maxAmount) throw new Error("Bond authorization must collect the full quoted amount");
  return {
    x402Version: 2,
    resource: { url: resource, description: "Refundable review commitment", mimeType: "application/json" },
    accepts: [{
      scheme: "auth-capture",
      network: BASE_SEPOLIA.network,
      amount: amount.toString(),
      asset: info.token,
      payTo: info.receiver,
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC", version: "2",
        authCaptureEscrow: BASE_SEPOLIA.authCaptureEscrow,
        captureAuthorizer: info.operator,
        operatorType: "custom",
        paymentFlow: "escrow",
        captureMode: "deferred",
        captureDeadline: info.authorizationExpiry,
        refundDeadline: info.refundExpiry,
        minFeeBps: 0, maxFeeBps: 0,
        feeRecipient: info.feeReceiver,
        assetTransferMethod: "eip3009",
      },
    }],
  } as const;
}

export const encodePaymentHeader = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64");
// GFH binds each payment to its contribution and collects through the custom operator.
