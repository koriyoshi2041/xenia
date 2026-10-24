// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GfhBondOperator} from "../src/GfhBondOperator.sol";
import {IAuthCaptureEscrow} from "../src/interfaces/IAuthCaptureEscrow.sol";
import {IEAS} from "../src/interfaces/IEAS.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISchemaRegistry {
    struct SchemaRecord { bytes32 uid; address resolver; bool revocable; string schema; }
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);
}
interface ITokenDomain { function DOMAIN_SEPARATOR() external view returns (bytes32); }
interface IReclaim { function reclaim(IAuthCaptureEscrow.PaymentInfo calldata info) external; }
interface IAttestations {
    struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }
    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

contract GfhBondOperatorTest is Test {
    IAuthCaptureEscrow constant ESCROW = IAuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    IEAS constant EAS = IEAS(0x4200000000000000000000000000000000000021);
    ISchemaRegistry constant REGISTRY = ISchemaRegistry(0x4200000000000000000000000000000000000020);
    string constant SCHEMA = "bytes32 queueId,uint64 repoId,uint64 itemNumber,uint64 githubUserId,uint8 kind,uint8 verdict,uint8 reasonCode,uint256 bondAmount,uint256 slashedAmount,bytes32 evidenceHash,bytes32 paymentInfoHash";
    bytes32 constant AUTH_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    GfhBondOperator op;
    bytes32 queue;
    bytes32 schema;
    address pool;
    address payer;
    uint256 constant ADJ_KEY = 0xA11CE;
    uint256 constant PAYER_KEY = 0xB0B;
    uint256 constant AMOUNT = 5e6;

    function setUp() public {
        pool = makeAddr("public-pool");
        payer = vm.addr(PAYER_KEY);
        schema = keccak256(abi.encodePacked(SCHEMA, address(0), false));
        if (REGISTRY.getSchema(schema).uid == bytes32(0)) REGISTRY.register(SCHEMA, address(0), false);
        address[] memory pools = new address[](1); pools[0] = pool;
        op = new GfhBondOperator(ESCROW, EAS, schema, pools);
        queue = op.registerQueue("github", 42, GfhBondOperator.Kind.PullRequests, GfhBondOperator.Queue(vm.addr(ADJ_KEY), pool, 14 days, true));
        deal(USDC, payer, 100e6);
    }

    function ref() internal view returns (GfhBondOperator.BondRef memory) {
        return GfhBondOperator.BondRef(queue, 7, 77, 0, 1);
    }

    function info(GfhBondOperator.BondRef memory r) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo(address(op), payer, pool, USDC, uint120(AMOUNT), uint48(block.timestamp + 300), uint48(block.timestamp + 28 days), uint48(block.timestamp + 28 days), 0, 0, pool, uint256(keccak256(abi.encode(r))));
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function authorization(IAuthCaptureEscrow.PaymentInfo memory p) internal view returns (bytes memory) {
        IAuthCaptureEscrow.PaymentInfo memory copy = abi.decode(abi.encode(p), (IAuthCaptureEscrow.PaymentInfo)); copy.payer = address(0);
        bytes32 nonce = ESCROW.getHash(copy);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenDomain(USDC).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(AUTH_TYPEHASH, payer, COLLECTOR, p.maxAmount, uint256(0), uint256(p.preApprovalExpiry), nonce))));
        return sign(PAYER_KEY, digest);
    }

    function post() internal returns (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) {
        r = ref(); p = info(r);
        bytes memory sig = authorization(p);
        op.postBond(p, AMOUNT, COLLECTOR, sig, r);
    }

    function resolve(IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r, GfhBondOperator.Verdict verdict, uint16 bps)
        internal returns (bytes32)
    {
        bytes32 evidence = keccak256("github:42/pull/7");
        bytes memory sig = sign(ADJ_KEY, op.verdictDigest(ESCROW.getHash(p), verdict, bps, 0, evidence));
        return op.resolve(p, r, verdict, bps, 0, evidence, sig);
    }

    function test_postBond_then_void() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        assertEq(IERC20(USDC).balanceOf(payer), 95e6);
        (, uint120 locked,) = ESCROW.paymentState(ESCROW.getHash(p)); assertEq(locked, AMOUNT);
        resolve(p, r, GfhBondOperator.Verdict.Accepted, 0);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6);
        (, locked,) = ESCROW.paymentState(ESCROW.getHash(p)); assertEq(locked, 0);
    }
    function test_spam_captures_to_pool_only() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        resolve(p, r, GfhBondOperator.Verdict.Spam, 10000);
        assertEq(IERC20(USDC).balanceOf(pool), AMOUNT);
        assertEq(IERC20(USDC).balanceOf(vm.addr(ADJ_KEY)), 0);
        assertEq(IERC20(USDC).balanceOf(payer), 95e6);
    }
    function test_goodFaith_cannot_slash() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        bytes memory sig = sign(ADJ_KEY, op.verdictDigest(ESCROW.getHash(p), GfhBondOperator.Verdict.GoodFaith, 10000, 0, bytes32(0)));
        vm.expectRevert(GfhBondOperator.SlashNotAllowedForVerdict.selector);
        op.resolve(p, r, GfhBondOperator.Verdict.GoodFaith, 10000, 0, bytes32(0), sig);
        resolve(p, r, GfhBondOperator.Verdict.GoodFaith, 0);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6);
    }
    function test_expire_after_window_by_anyone() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        vm.warp(block.timestamp + 14 days);
        vm.prank(makeAddr("anyone")); op.expire(p, r);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6);
    }
    function test_payer_reclaims_if_operator_disappears() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        vm.warp(uint256(p.authorizationExpiry) + 1);
        vm.prank(payer); IReclaim(address(ESCROW)).reclaim(p);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6);
        op.expire(p, r);
    }
    function test_downgraded_partial_slash() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        resolve(p, r, GfhBondOperator.Verdict.Downgraded, 2500);
        assertEq(IERC20(USDC).balanceOf(pool), 1_250_000);
        assertEq(IERC20(USDC).balanceOf(payer), 98_750_000);
    }
    function test_verdict_attested_on_eas() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        bytes32 uid = resolve(p, r, GfhBondOperator.Verdict.Accepted, 0);
        IAttestations.Attestation memory a = IAttestations(address(EAS)).getAttestation(uid);
        assertEq(a.uid, uid); assertEq(a.attester, address(op)); assertEq(a.recipient, payer); assertEq(a.schema, schema);
        assertEq(a.data, abi.encode(queue, uint64(42), uint64(7), uint64(77), uint8(0), uint8(1), uint8(0), uint256(AMOUNT), uint256(0), keccak256("github:42/pull/7"), ESCROW.getHash(p)));
    }
    function test_standard_authorize_wrapper() public {
        GfhBondOperator.BondRef memory r = ref();
        IAuthCaptureEscrow.PaymentInfo memory p = info(r);
        bytes memory sig = authorization(p);
        op.registerRef(r);
        op.authorize(p, AMOUNT, COLLECTOR, sig);
        resolve(p, r, GfhBondOperator.Verdict.Accepted, 0);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6);
    }
    function test_immediate_charge_is_not_a_review_bond() public {
        IAuthCaptureEscrow.PaymentInfo memory p = info(ref());
        vm.expectRevert(GfhBondOperator.DeferredBondOnly.selector);
        op.charge(p, AMOUNT, COLLECTOR, hex"", 0, pool);
    }
    function test_exempt_contribution_still_attested() public {
        GfhBondOperator.BondRef memory r = ref();
        bytes32 evidence = keccak256("github:42/pull/7");
        bytes memory sig = sign(ADJ_KEY, op.contributionDigest(r, payer, GfhBondOperator.Verdict.Accepted, 0, evidence));
        bytes32 uid = op.recordContribution(r, payer, GfhBondOperator.Verdict.Accepted, 0, evidence, sig);
        IAttestations.Attestation memory a = IAttestations(address(EAS)).getAttestation(uid);
        assertEq(a.attester, address(op)); assertEq(IERC20(USDC).balanceOf(payer), 100e6);
        vm.expectRevert(GfhBondOperator.AlreadyRecorded.selector);
        op.recordContribution(r, payer, GfhBondOperator.Verdict.Accepted, 0, evidence, sig);
    }
    function test_ref_and_verdict_signature_bind_to_the_payment() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, GfhBondOperator.BondRef memory r) = post();
        bytes memory sig = sign(PAYER_KEY, op.verdictDigest(ESCROW.getHash(p), GfhBondOperator.Verdict.Accepted, 0, 0, bytes32(0)));
        vm.expectRevert(GfhBondOperator.BadVerdictSignature.selector);
        op.resolve(p, r, GfhBondOperator.Verdict.Accepted, 0, 0, bytes32(0), sig);
        r.itemNumber++;
        vm.expectRevert(GfhBondOperator.RefMismatch.selector); op.expire(p, r);
    }
    function test_queue_registration_owned_by_app_deployer() public {
        vm.prank(payer); vm.expectRevert();
        op.registerQueue("github", 43, GfhBondOperator.Kind.PullRequests, GfhBondOperator.Queue(vm.addr(ADJ_KEY), pool, 14 days, true));
    }
}
