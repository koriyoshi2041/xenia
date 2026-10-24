import type { Address, Hex } from "viem";
import type { ItemState, QueueKind, Quote } from "./types.ts";
import type { Policy } from "./pricing.ts";

export interface Queue {
  id: Hex;
  repo: string;
  repoId: number;
  kind: QueueKind;
  adjudicator: Address;
  pool: Address;
  reviewWindow: number;
  policy: Policy;
  trusts: { queueId: Hex; weight: number }[];
  acceptedKinds: QueueKind[];
  githubHistory: boolean;
  minStars: number;
  policyRevision?: number;
  policyProof?: {
    signature: Hex;
    expiresAt: number;
    signer: Address;
    hash: Hex;
  };
}
export interface PullRequest {
  repo: string;
  repoId: number;
  number: number;
  authorId: number;
  authorLogin: string;
  title?: string;
  draft?: boolean;
  updatedAt?: string;
  headSha: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  labels: string[];
}
export interface Contribution {
  uid: Hex;
  queueId: Hex;
  repoId: number;
  itemNumber: number;
  githubUserId: number;
  kind: QueueKind;
  verdict: number;
  reasonCode: number;
  bondAmount: string;
  slashedAmount: string;
  evidenceHash: Hex;
  paymentInfoHash: Hex;
  recipient: Address;
  recordedAt?: number;
  blockNumber: string;
  txHash: Hex;
}

/** A contribution fact interpreted under one target community's policy. */
export interface RecognizedContribution extends Contribution {
  weight: number;
  path: Hex[];
}

export interface CommunityQuote extends Quote {
  credits: number;
  recognized: RecognizedContribution[];
  historical: { repo: string; number: number }[];
  githubUserId: number;
}

/** JSON-safe contribution fields consumed by the workbench. */
export interface ReviewItem {
  queueId: Hex;
  pr: PullRequest;
  state: ItemState;
  admittedAt?: string;
  quote: Quote;
  txPost?: Hex;
  txResolve?: Hex;
  verdict?: number;
  attestation?: Hex;
  previousRounds?: Omit<ReviewItem, "previousRounds">[];
}

export interface NetworkSnapshot {
  queues: Queue[];
  records: Contribution[];
  runtime: {
    mode: string;
    chainId: number;
    operator?: Address;
    requirements?: string[];
  };
}
