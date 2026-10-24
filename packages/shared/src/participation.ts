import { BASE_SEPOLIA } from "./addresses.ts";
import type { CommunityQuote, Queue } from "./community.ts";

/** Read before creating a PR; this describes the next contribution under current policy. */
export function participationBrief(community: Queue, quote: CommunityQuote) {
  if (community.kind !== "pull_requests")
    throw new Error("Participation preparation currently supports pull request queues");

  return {
    community,
    quote,
    admission: quote.blocked
      ? "blocked" as const
      : quote.exempt
        ? "exempt" as const
        : "bond_required" as const,
    review: {
      endpoint: `/api/review-queue?repo=${encodeURIComponent(community.repo)}`,
      pullRequestState: "open" as const,
      draft: false,
      admittedStates: ["BONDED", "EXEMPT"] as const,
      order: "admitted_at" as const,
      decision: "maintainer_review" as const,
    },
    commitment: {
      appliesTo: "posted_bonds" as const,
      asset: BASE_SEPOLIA.usdc,
      network: BASE_SEPOLIA.network,
      symbol: "USDC" as const,
      decimals: 6,
      refundRecipient: "original_payer" as const,
      publicPool: community.pool,
      reviewWindowSeconds: community.reviewWindow,
      windowStartsAt: "bond_confirmation" as const,
      outcomes: {
        Accepted: {
          trigger: "pull_request_merged",
          funds: "full_refund",
          recognition: "accepted_record",
        },
        GoodFaith: {
          trigger: "closed_unmerged_without_gfh_spam_label",
          funds: "full_refund",
          recognition: "history_only",
        },
        Spam: {
          trigger: "closed_unmerged_with_gfh_spam_label",
          funds: "public_pool",
          recognition: "spam_record",
        },
        Timeout: {
          trigger: "unresolved_bond_reaches_review_deadline",
          funds: "permissionless_full_refund",
          recognition: "history_only",
        },
      },
    },
  };
}

export type ParticipationBrief = ReturnType<typeof participationBrief>;
