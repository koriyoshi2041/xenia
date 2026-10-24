// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAuthCaptureEscrow} from "./interfaces/IAuthCaptureEscrow.sol";
import {IEAS} from "./interfaces/IEAS.sol";

/// @notice Community review commitments, settled by the deployed AuthCaptureEscrow.
contract GfhBondOperator is Ownable, EIP712, ReentrancyGuard {
    enum Kind { PullRequests, SecurityReports }
    enum Verdict { None, Accepted, GoodFaith, Downgraded, Spam, Timeout }

    struct Queue { address adjudicator; address pool; uint48 reviewWindow; bool active; }
    struct BondRef { bytes32 queueId; uint64 itemNumber; uint64 githubUserId; uint8 claimedSeverity; uint96 nonce; }
    struct Bond {
        bytes32 queueId;
        uint64 itemNumber;
        uint48 postedAt;
        uint48 reviewDeadline;
        address adjudicator;
        uint120 amount;
        bool resolved;
    }
    struct Counters { uint64 posted; uint64 refunded; uint64 slashed; uint64 expired; }

    IAuthCaptureEscrow public immutable ESCROW;
    IEAS public immutable EAS;
    bytes32 public immutable VERDICT_SCHEMA;
    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 paymentInfoHash,uint8 verdict,uint16 slashBps,uint8 reasonCode,bytes32 evidenceHash)"
    );
    bytes32 public constant CONTRIBUTION_TYPEHASH = keccak256(
        "Contribution(bytes32 refHash,address recipient,uint8 verdict,uint8 reasonCode,bytes32 evidenceHash)"
    );

    mapping(bytes32 => Queue) public queues;
    mapping(bytes32 => Counters) public counters;
    mapping(bytes32 => Bond) public bonds;
    mapping(address => bool) public poolAllowed;
    mapping(bytes32 => uint64) public repoIds;
    mapping(bytes32 => Kind) public kinds;
    mapping(bytes32 => BondRef) private refs;
    mapping(bytes32 => bool) public recorded;

    event QueueRegistered(bytes32 indexed queueId, string platform, uint64 repoId, Kind kind, address adjudicator, address pool);
    event BondPosted(bytes32 indexed queueId, uint64 indexed itemNumber, bytes32 indexed paymentInfoHash, address payer, uint64 githubUserId, uint256 amount);
    event BondResolved(bytes32 indexed queueId, uint64 indexed itemNumber, bytes32 indexed paymentInfoHash, Verdict verdict, uint8 reasonCode, uint256 slashed, uint256 refunded, bytes32 evidenceHash, bytes32 attestationUid);
    event ContributionRecorded(bytes32 indexed queueId, uint64 indexed githubUserId, bytes32 indexed attestationUid, uint64 itemNumber, Verdict verdict, bytes32 paymentInfoHash);

    error QueueInactive();
    error QueueExists();
    error InvalidQueue();
    error PoolNotAllowed();
    error PoolMismatch();
    error OperatorMismatch();
    error FeesNotAllowed();
    error WindowTooShort();
    error RefMismatch();
    error BadVerdictSignature();
    error SlashNotAllowedForVerdict();
    error AlreadyResolved();
    error UnknownBond();
    error InvalidAmount();
    error WindowNotElapsed();
    error WindowElapsed();
    error AlreadyRecorded();
    error DeferredBondOnly();

    constructor(IAuthCaptureEscrow escrow, IEAS eas, bytes32 verdictSchema, address[] memory pools)
        Ownable(msg.sender) EIP712("Gas for Humans", "1")
    {
        require(address(escrow) != address(0) && address(eas) != address(0) && verdictSchema != bytes32(0), "Missing deployment");
        ESCROW = escrow;
        EAS = eas;
        VERDICT_SCHEMA = verdictSchema;
        for (uint256 i; i < pools.length; ++i) {
            require(pools[i] != address(0), "Zero pool");
            poolAllowed[pools[i]] = true;
        }
    }

    function queueId(string calldata platform, uint64 repoId, Kind kind) public pure returns (bytes32) {
        return keccak256(abi.encode(platform, repoId, kind));
    }

    function registerQueue(string calldata platform, uint64 repoId, Kind kind, Queue calldata q)
        external onlyOwner returns (bytes32 id)
    {
        if (!poolAllowed[q.pool]) revert PoolNotAllowed();
        if (q.adjudicator == address(0) || q.adjudicator == q.pool || q.reviewWindow == 0) revert InvalidQueue();
        id = queueId(platform, repoId, kind);
        if (queues[id].adjudicator != address(0)) revert QueueExists();
        queues[id] = q;
        repoIds[id] = repoId;
        kinds[id] = kind;
        emit QueueRegistered(id, platform, repoId, kind, q.adjudicator, q.pool);
    }

    /// @notice Publish the preimage used by the four-argument collect wrapper.
    function registerRef(BondRef calldata ref) external {
        if (!queues[ref.queueId].active) revert QueueInactive();
        refs[keccak256(abi.encode(ref))] = ref;
    }

    /// @notice Collect entry point for the GFH-aware x402 escrow adapter.
    function authorize(IAuthCaptureEscrow.PaymentInfo calldata info, uint256 amount, address collector, bytes calldata data)
        external nonReentrant
    {
        BondRef memory ref = refs[bytes32(info.salt)];
        _post(info, amount, collector, data, ref);
    }

    /// @notice The collect ABI includes charge; this operator only advertises deferred escrow.
    function charge(IAuthCaptureEscrow.PaymentInfo calldata, uint256, address, bytes calldata, uint256, address)
        external pure
    {
        revert DeferredBondOnly();
    }

    /// @notice Direct SDK entry point, including the contribution reference in the same transaction.
    function postBond(IAuthCaptureEscrow.PaymentInfo calldata info, uint256 amount, address collector, bytes calldata data, BondRef calldata ref)
        external nonReentrant
    {
        _post(info, amount, collector, data, ref);
    }

    function _post(IAuthCaptureEscrow.PaymentInfo calldata info, uint256 amount, address collector, bytes calldata data, BondRef memory ref) private {
        Queue memory q = queues[ref.queueId];
        if (!q.active) revert QueueInactive();
        if (info.operator != address(this)) revert OperatorMismatch();
        if (info.receiver != q.pool) revert PoolMismatch();
        if (info.minFeeBps != 0 || info.maxFeeBps != 0) revert FeesNotAllowed();
        if (info.authorizationExpiry < block.timestamp + q.reviewWindow) revert WindowTooShort();
        if (info.salt != uint256(keccak256(abi.encode(ref)))) revert RefMismatch();
        if (amount == 0 || amount != info.maxAmount) revert InvalidAmount();
        bytes32 hash = ESCROW.getHash(info);
        if (bonds[hash].queueId != bytes32(0)) revert AlreadyResolved();
        bonds[hash] = Bond(ref.queueId, ref.itemNumber, uint48(block.timestamp), uint48(block.timestamp) + q.reviewWindow, q.adjudicator, uint120(amount), false);
        counters[ref.queueId].posted++;
        ESCROW.authorize(info, amount, collector, data);
        emit BondPosted(ref.queueId, ref.itemNumber, hash, info.payer, ref.githubUserId, amount);
    }

    function verdictDigest(bytes32 paymentHash, Verdict verdict, uint16 slashBps, uint8 reasonCode, bytes32 evidenceHash)
        public view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, paymentHash, verdict, slashBps, reasonCode, evidenceHash)));
    }

    function resolve(IAuthCaptureEscrow.PaymentInfo calldata info, BondRef calldata ref, Verdict verdict, uint16 slashBps, uint8 reasonCode, bytes32 evidenceHash, bytes calldata adjudicatorSig)
        external nonReentrant returns (bytes32 attestationUid)
    {
        bytes32 hash = _bondHash(info, ref);
        Bond storage bond = bonds[hash];
        if (block.timestamp >= bond.reviewDeadline) revert WindowElapsed();
        if (ECDSA.recover(verdictDigest(hash, verdict, slashBps, reasonCode, evidenceHash), adjudicatorSig) != bond.adjudicator) revert BadVerdictSignature();
        bool valid = ((verdict == Verdict.Accepted || verdict == Verdict.GoodFaith) && slashBps == 0)
            || (verdict == Verdict.Spam && slashBps == 10_000)
            || (verdict == Verdict.Downgraded && slashBps > 0 && slashBps < 10_000);
        if (!valid) revert SlashNotAllowedForVerdict();
        bond.resolved = true;
        uint256 slashed = uint256(bond.amount) * slashBps / 10_000;
        uint256 refunded = uint256(bond.amount) - slashed;
        if (slashed > 0) ESCROW.capture(info, slashed, 0, info.feeReceiver);
        if (refunded > 0) ESCROW.void(info);
        if (slashed > 0) counters[ref.queueId].slashed++;
        else counters[ref.queueId].refunded++;
        attestationUid = _attest(ref, info.payer, verdict, reasonCode, evidenceHash, hash, bond.amount, slashed);
        emit BondResolved(ref.queueId, ref.itemNumber, hash, verdict, reasonCode, slashed, refunded, evidenceHash, attestationUid);
    }

    function expire(IAuthCaptureEscrow.PaymentInfo calldata info, BondRef calldata ref) external nonReentrant {
        bytes32 hash = _bondHash(info, ref);
        Bond storage bond = bonds[hash];
        if (block.timestamp < bond.reviewDeadline) revert WindowNotElapsed();
        bond.resolved = true;
        (, uint120 remaining,) = ESCROW.paymentState(hash);
        if (remaining > 0) ESCROW.void(info);
        counters[ref.queueId].expired++;
        bytes32 uid = _attest(ref, info.payer, Verdict.Timeout, 0, bytes32(0), hash, bond.amount, 0);
        emit BondResolved(ref.queueId, ref.itemNumber, hash, Verdict.Timeout, 0, 0, bond.amount, bytes32(0), uid);
    }

    function contributionDigest(BondRef calldata ref, address recipient, Verdict verdict, uint8 reasonCode, bytes32 evidenceHash)
        public view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CONTRIBUTION_TYPEHASH, keccak256(abi.encode(ref)), recipient, verdict, reasonCode, evidenceHash)));
    }

    /// @notice Publish a maintainer-signed result for an exempt contribution.
    function recordContribution(BondRef calldata ref, address recipient, Verdict verdict, uint8 reasonCode, bytes32 evidenceHash, bytes calldata signature)
        external nonReentrant returns (bytes32)
    {
        Queue memory q = queues[ref.queueId];
        if (!q.active) revert QueueInactive();
        if (verdict != Verdict.Accepted && verdict != Verdict.GoodFaith && verdict != Verdict.Spam) revert SlashNotAllowedForVerdict();
        if (ECDSA.recover(contributionDigest(ref, recipient, verdict, reasonCode, evidenceHash), signature) != q.adjudicator) revert BadVerdictSignature();
        return _attest(ref, recipient, verdict, reasonCode, evidenceHash, bytes32(0), 0, 0);
    }

    function _bondHash(IAuthCaptureEscrow.PaymentInfo calldata info, BondRef calldata ref) private view returns (bytes32 hash) {
        if (info.salt != uint256(keccak256(abi.encode(ref)))) revert RefMismatch();
        hash = ESCROW.getHash(info);
        Bond storage bond = bonds[hash];
        if (bond.queueId == bytes32(0)) revert UnknownBond();
        if (bond.resolved) revert AlreadyResolved();
    }

    function _attest(BondRef memory ref, address recipient, Verdict verdict, uint8 reasonCode, bytes32 evidenceHash, bytes32 hash, uint256 amount, uint256 slashed)
        private returns (bytes32 uid)
    {
        bytes32 key = keccak256(abi.encode(ref));
        if (recorded[key]) revert AlreadyRecorded();
        recorded[key] = true;
        uid = EAS.attest(IEAS.AttestationRequest({
            schema: VERDICT_SCHEMA,
            data: IEAS.AttestationRequestData({
                recipient: recipient, expirationTime: 0, revocable: false, refUID: bytes32(0),
                data: abi.encode(ref.queueId, repoIds[ref.queueId], ref.itemNumber, ref.githubUserId, uint8(kinds[ref.queueId]), uint8(verdict), reasonCode, amount, slashed, evidenceHash, hash),
                value: 0
            })
        }));
        emit ContributionRecorded(ref.queueId, ref.githubUserId, uid, ref.itemNumber, verdict, hash);
    }
}
