import {
  createPublicClient, http, decodeAbiParameters, parseEventLogs,
  encodeAbiParameters, parseAbiParameters, keccak256, type Address, type Hex,
} from "viem";
import { BASE_SEPOLIA } from "./addresses.ts";
import { canonicalJson, communityPolicyTypedData } from "./community-policy.ts";
import { Verdict } from "./types.ts";
import { trustedRecords } from "./recognition.ts";
import { contributionFields, easAbi, operatorAbi } from "./abi.ts";
import type { Contribution, Queue } from "./community.ts";

export interface Passport {
  version: "gfh-passport/1";
  exportedAt: string;
  network: {
    mode: string; chainId: number; operator: Address; eas: Address;
    anchor: { number: string; hash: Hex };
  };
  subject: { githubUserId: number; login: string };
  communities: Queue[];
  records: Contribution[];
  recognition: ReturnType<typeof passportRecognition>;
}

export function passportRecognition(communities: Queue[], records: Contribution[]) {
  return communities.map((q) => {
    const accepted = trustedRecords(q, communities, records)
      .filter((r) => r.verdict === Verdict.Accepted);
    return {
      queueId: q.id,
      policyRevision: q.policyRevision ?? 0,
      acceptedCredits: accepted.reduce((sum, r) => sum + r.weight, 0),
      paths: accepted.map((r) => ({ uid: r.uid, weight: r.weight, path: r.path })),
    };
  });
}

function requireMatch(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Uses only a JSON bundle, an explicitly selected Operator, and RPC. No GFH server or keys. */
export async function verifyPassport(passport: Passport, rpcUrl: string, operator: Address) {
  requireMatch(passport.version === "gfh-passport/1", "Unsupported passport version");
  requireMatch(sameAddress(passport.network.operator, operator), "Unexpected Operator");
  requireMatch(sameAddress(passport.network.eas, BASE_SEPOLIA.eas), "Unexpected EAS contract");
  const client = createPublicClient({ transport: http(rpcUrl) });
  const blockNumber = BigInt(passport.network.anchor.number);
  const [chainId, anchor, schema] = await Promise.all([
    client.getChainId(), client.getBlock({ blockNumber }),
    client.readContract({ address: operator, abi: operatorAbi, functionName: "VERDICT_SCHEMA" }),
  ]);
  requireMatch(chainId === BASE_SEPOLIA.chainId && chainId === passport.network.chainId, "Chain id mismatch");
  requireMatch(anchor.hash === passport.network.anchor.hash, "RPC does not match the passport's chain snapshot");
  const policies = [];
  for (const q of passport.communities) {
    const id = keccak256(encodeAbiParameters(parseAbiParameters("string,uint64,uint8"), [
      "github", BigInt(q.repoId), q.kind === "pull_requests" ? 0 : 1,
    ]));
    requireMatch(id === q.id, "Community id does not match its repository id");
    const registered = await client.readContract({ address: operator, abi: operatorAbi, functionName: "queues", args: [q.id], blockNumber });
    requireMatch(
      sameAddress(registered[0], q.adjudicator) && sameAddress(registered[1], q.pool)
      && Number(registered[2]) === q.reviewWindow && registered[3],
      "Community registration differs from chain",
    );
    if (q.policyProof) {
      const document = { trusts: q.trusts, acceptedKinds: q.acceptedKinds, policy: q.policy };
      const typed = communityPolicyTypedData(operator, q.id, document, q.policyRevision ?? 0, q.policyProof.expiresAt);
      requireMatch(typed.message.policyHash === q.policyProof.hash, "Policy document hash mismatch");
      requireMatch(sameAddress(q.policyProof.signer, q.adjudicator), "Policy signer differs from registered adjudicator");
      requireMatch(await client.verifyTypedData({ ...typed, address: q.adjudicator, signature: q.policyProof.signature }), "Invalid community policy signature");
    } else requireMatch(!q.policyRevision, "Versioned policy is missing its signature");
    policies.push({ queueId: q.id, revision: q.policyRevision ?? 0, signatureVerified: Boolean(q.policyProof) });
  }
  requireMatch(new Set(passport.records.map((r) => r.uid)).size === passport.records.length, "Duplicate contribution UID");
  for (const record of passport.records) {
    requireMatch(record.githubUserId === passport.subject.githubUserId, "Contribution subject mismatch");
    const issuer = passport.communities.find((q) => q.id === record.queueId);
    requireMatch(Boolean(issuer && issuer.repoId === record.repoId), "Unknown contribution community");
    requireMatch(BigInt(record.blockNumber) <= blockNumber, "Contribution is newer than the snapshot");
    const [attestation, receipt] = await Promise.all([
      client.readContract({ address: BASE_SEPOLIA.eas, abi: easAbi, functionName: "getAttestation", args: [record.uid] }),
      client.getTransactionReceipt({ hash: record.txHash }),
    ]);
    requireMatch(attestation.uid === record.uid && attestation.schema === schema
      && sameAddress(attestation.attester, operator) && attestation.revocationTime === 0n
      && (attestation.expirationTime === 0n || attestation.expirationTime > anchor.timestamp), "Invalid EAS attestation");
    const decoded = decodeAbiParameters(contributionFields, attestation.data);
    const claimed = [record.queueId, BigInt(record.repoId), BigInt(record.itemNumber), BigInt(record.githubUserId),
      record.kind === "pull_requests" ? 0 : 1, record.verdict, record.reasonCode, BigInt(record.bondAmount),
      BigInt(record.slashedAmount), record.evidenceHash, record.paymentInfoHash];
    requireMatch(decoded.every((value, i) => value === claimed[i])
      && sameAddress(attestation.recipient, record.recipient) && Number(attestation.time) === record.recordedAt,
      "Contribution fields differ from EAS");
    const events = parseEventLogs({ abi: operatorAbi, eventName: "ContributionRecorded", logs: receipt.logs });
    requireMatch(receipt.status === "success" && String(receipt.blockNumber) === record.blockNumber
      && events.some((e) => sameAddress(e.address, operator) && e.args.attestationUid === record.uid
        && e.args.queueId === record.queueId && e.args.githubUserId === BigInt(record.githubUserId)
        && e.args.itemNumber === BigInt(record.itemNumber) && e.args.verdict === record.verdict
        && e.args.paymentInfoHash === record.paymentInfoHash), "Contribution transaction does not match EAS record");
  }
  const recomputed = passportRecognition(passport.communities, passport.records);
  requireMatch(canonicalJson(recomputed) === canonicalJson(passport.recognition), "Recognition paths differ from supplied policies");
  return {
    verified: true, mode: passport.network.mode, operator, anchor: passport.network.anchor,
    githubUserId: passport.subject.githubUserId, recordsVerified: passport.records.length,
    policies, recognition: recomputed,
    scope: "EAS facts and policy signatures at the supplied snapshot; recognition uses the supplied record set. GitHub login/repository names are display metadata. Policy freshness and record-set completeness are not established by this bundle.",
  };
}
