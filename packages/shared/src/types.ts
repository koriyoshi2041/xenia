// Domain types shared by server, web and mcp. Mirrors IGfhBondOperator.sol.

export type QueueKind = "pull_requests" | "security_reports";

/** Same order as the Solidity enum. */
export const Verdict = {
  None: 0,
  Accepted: 1,
  GoodFaith: 2,
  Downgraded: 3,
  Spam: 4,
  Timeout: 5,
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const ReasonCode = {
  None: 0,
  Fabricated: 1,
  DuplicateMass: 2,
  OffTopic: 3,
  AiUnreviewed: 4,
  Other: 5,
} as const;
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/** keccak256(abi.encode(ref)) is the escrow PaymentInfo.salt, so the payer's signature names the PR. */
export interface BondRef {
  queueId: `0x${string}`;
  itemNumber: bigint;
  githubUserId: bigint;
  claimedSeverity: number; // 0 for PRs, 1..4 for security reports
  nonce: bigint;
}

export interface QuoteReason {
  rule: string;
  detail: string;
}

export interface Quote {
  /** Token units as a decimal number of USDC (UI); converted to 6-decimals at the chain boundary. */
  amount: number;
  exempt: boolean;
  blocked: boolean;
  reasons: QuoteReason[];
}

export type ItemState =
  | "AWAITING_BOND"
  | "EXEMPT"
  | "BONDED"
  | "RESOLVED"
  | "CLOSED_UNBONDED";
