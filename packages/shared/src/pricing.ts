// Bond pricing: a pure function of contribution signals and community policy.
import type { Quote, QuoteReason } from "./types.ts";

export interface Signals {
  isInfraBot: boolean;
  hasWriteAccess: boolean;
  vouched: boolean;
  denounced: boolean;
  /** Weighted Accepted attestations + eligible GitHub merges, deduplicated by repository and PR. */
  records: number;
  /** Spam verdicts against this identity in the last 180 days, any trusted queue. */
  recentSlashes: number;
  accountAgeDays: number;
  /** This author's other items currently open in this queue. */
  openInQueue: number;
}

export interface Policy {
  baseBond: number;
  exemptMinRecords: number;
  oneRecordMultiplier: number;
  youngAccount: { days: number; multiplier: number }[]; // checked in order, first match wins
  concurrency: { freeOpen: number; multiplier: number };
  perSlashMultiplier: number;
  maxSlashMultiplier: number;
  denounced: "block" | { multiplier: number };
}

export const DEFAULT_POLICY: Policy = {
  baseBond: 5,
  exemptMinRecords: 2,
  oneRecordMultiplier: 0.1,
  youngAccount: [
    { days: 30, multiplier: 4 },
    { days: 180, multiplier: 2 },
  ],
  concurrency: { freeOpen: 3, multiplier: 2 },
  perSlashMultiplier: 2,
  maxSlashMultiplier: 8,
  denounced: { multiplier: 4 },
};

const free = (rule: string, detail: string): Quote => ({ amount: 0, exempt: true, blocked: false, reasons: [{ rule, detail }] });

export function quote(s: Signals, p: Policy = DEFAULT_POLICY): Quote {
  if (s.isInfraBot) return free("bot", "Repository automation");
  if (s.hasWriteAccess) return free("write_access", "Maintainer or collaborator");
  if (s.vouched) return free("vouched", "Vouched for in a trusted list");
  if (s.denounced && p.denounced === "block") {
    return { amount: 0, exempt: false, blocked: true, reasons: [{ rule: "denounced", detail: "Blocked by repository policy" }] };
  }
  if (s.records >= p.exemptMinRecords && s.recentSlashes === 0) {
    return free("record", `${s.records} merged contributions in trusted repos`);
  }

  const reasons: QuoteReason[] = [];
  let amount = p.baseBond;
  if (s.records >= 1) {
    amount *= p.oneRecordMultiplier;
    reasons.push({ rule: "record", detail: `${s.records} merged contribution(s): ×${p.oneRecordMultiplier}` });
  } else {
    reasons.push({ rule: "no_record", detail: `No merged contributions in trusted repos: base ${p.baseBond}` });
  }
  const young = p.youngAccount.find((y) => s.accountAgeDays < y.days);
  if (young) {
    amount *= young.multiplier;
    reasons.push({ rule: "young_account", detail: `Account younger than ${young.days} days: ×${young.multiplier}` });
  }
  if (s.openInQueue >= p.concurrency.freeOpen) {
    amount *= p.concurrency.multiplier;
    reasons.push({ rule: "concurrency", detail: `${s.openInQueue} other open items here: ×${p.concurrency.multiplier}` });
  }
  if (s.recentSlashes > 0) {
    const m = Math.min(p.perSlashMultiplier ** s.recentSlashes, p.maxSlashMultiplier);
    amount *= m;
    reasons.push({ rule: "slashed", detail: `${s.recentSlashes} spam verdict(s) in 180 days: ×${m}` });
  }
  if (s.denounced && p.denounced !== "block") {
    amount *= p.denounced.multiplier;
    reasons.push({ rule: "denounced", detail: `Denounced in a trusted list: ×${p.denounced.multiplier}` });
  }
  amount = Math.round(amount * 100) / 100;
  if (amount === 0)
    reasons.push({ rule: "zero_bond", detail: "Community policy requires no bond" });
  return { amount, exempt: amount === 0, blocked: false, reasons };
}
