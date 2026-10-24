// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Script} from "forge-std/Script.sol";
import {GfhBondOperator} from "../src/GfhBondOperator.sol";
import {IAuthCaptureEscrow} from "../src/interfaces/IAuthCaptureEscrow.sol";
import {IEAS} from "../src/interfaces/IEAS.sol";
interface ISchemaRegistryDeploy {
    struct SchemaRecord { bytes32 uid; address resolver; bool revocable; string schema; }
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);
}
contract Deploy is Script {
    string constant SCHEMA = "bytes32 queueId,uint64 repoId,uint64 itemNumber,uint64 githubUserId,uint8 kind,uint8 verdict,uint8 reasonCode,uint256 bondAmount,uint256 slashedAmount,bytes32 evidenceHash,bytes32 paymentInfoHash";
    function run() external {
        address[] memory pools = new address[](1); pools[0] = vm.envAddress("POOL_ADDRESS");
        ISchemaRegistryDeploy registry = ISchemaRegistryDeploy(0x4200000000000000000000000000000000000020);
        bytes32 schema = keccak256(abi.encodePacked(SCHEMA, address(0), false));
        vm.startBroadcast(vm.envUint("RELAYER_PRIVATE_KEY"));
        if (registry.getSchema(schema).uid == bytes32(0)) registry.register(SCHEMA, address(0), false);
        new GfhBondOperator(IAuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c), IEAS(0x4200000000000000000000000000000000000021), schema, pools);
        vm.stopBroadcast();
    }
}
