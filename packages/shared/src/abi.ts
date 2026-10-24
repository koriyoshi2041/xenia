import { parseAbi, parseAbiParameters } from "viem";

// Human-readable ABI fragments (viem `parseAbi`). Keep in sync with contracts/src.

const PAYMENT_INFO =
  "(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt)";
const BOND_REF = "(bytes32 queueId, uint64 itemNumber, uint64 githubUserId, uint8 claimedSeverity, uint96 nonce)";

export const gfhBondOperatorAbi = [
  `function postBond(${PAYMENT_INFO} info, uint256 amount, address tokenCollector, bytes collectorData, ${BOND_REF} ref)`,
  `function resolve(${PAYMENT_INFO} info, ${BOND_REF} ref, uint8 verdict, uint16 slashBps, uint8 reasonCode, bytes32 evidenceHash, bytes adjudicatorSig) returns (bytes32)`,
  `function expire(${PAYMENT_INFO} info, ${BOND_REF} ref)`,
  "event BondPosted(bytes32 indexed queueId, uint64 indexed itemNumber, bytes32 indexed paymentInfoHash, address payer, uint64 githubUserId, uint256 amount)",
  "event BondResolved(bytes32 indexed queueId, uint64 indexed itemNumber, bytes32 indexed paymentInfoHash, uint8 verdict, uint8 reasonCode, uint256 slashed, uint256 refunded, bytes32 evidenceHash, bytes32 attestationUid)",
] as const;

export const authCaptureEscrowAbi = [
  `function getHash(${PAYMENT_INFO} paymentInfo) view returns (bytes32)`,
  `function reclaim(${PAYMENT_INFO} paymentInfo)`,
  "function paymentState(bytes32) view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount)",
] as const;

export const operatorAbi = parseAbi([
  ...gfhBondOperatorAbi,
  "function registerQueue(string platform,uint64 repoId,uint8 kind,(address adjudicator,address pool,uint48 reviewWindow,bool active) q) returns (bytes32)",
  "function queues(bytes32) view returns (address adjudicator,address pool,uint48 reviewWindow,bool active)",
  "function VERDICT_SCHEMA() view returns (bytes32)",
  "function bonds(bytes32) view returns (bytes32 queueId,uint64 itemNumber,uint48 postedAt,uint48 reviewDeadline,address adjudicator,uint120 amount,bool resolved)",
  `function recordContribution(${BOND_REF} ref,address recipient,uint8 verdict,uint8 reasonCode,bytes32 evidenceHash,bytes signature) returns (bytes32)`,
  "event ContributionRecorded(bytes32 indexed queueId,uint64 indexed githubUserId,bytes32 indexed attestationUid,uint64 itemNumber,uint8 verdict,bytes32 paymentInfoHash)",
]);
export const easAbi = parseAbi([
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
]);
export const contributionFields = parseAbiParameters(
  "bytes32 queueId,uint64 repoId,uint64 itemNumber,uint64 githubUserId,uint8 kind,uint8 verdict,uint8 reasonCode,uint256 bondAmount,uint256 slashedAmount,bytes32 evidenceHash,bytes32 paymentInfoHash",
);
