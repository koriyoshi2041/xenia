import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodePacked,
  keccak256,
  zeroAddress,
  zeroHash,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA } from "@gfh/shared";
export const CONTRIBUTION_SCHEMA =
  "bytes32 queueId,uint64 repoId,uint64 itemNumber,uint64 githubUserId,uint8 kind,uint8 verdict,uint8 reasonCode,uint256 bondAmount,uint256 slashedAmount,bytes32 evidenceHash,bytes32 paymentInfoHash";
export async function deploy(rpcUrl: string, key: Hex, pool: Address) {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
    pollingInterval: 100,
  });
  const wallet = createWalletClient({
    chain: baseSepolia,
    account: privateKeyToAccount(key),
    transport: http(rpcUrl),
  });
  if ((await publicClient.getChainId()) !== 84532)
    throw new Error("Expected Base Sepolia chain id 84532");
  const schema = keccak256(
    encodePacked(
      ["string", "address", "bool"],
      [CONTRIBUTION_SCHEMA, zeroAddress, false],
    ),
  );
  const registryAbi = parseAbi([
    "function register(string schema,address resolver,bool revocable) returns(bytes32)",
    "function getSchema(bytes32 uid) view returns((bytes32 uid,address resolver,bool revocable,string schema))",
  ]);
  const existing = await publicClient.readContract({
    address: BASE_SEPOLIA.easSchemaRegistry,
    abi: registryAbi,
    functionName: "getSchema",
    args: [schema],
  });
  if (existing.uid === zeroHash) {
    const hash = await wallet.writeContract({
      address: BASE_SEPOLIA.easSchemaRegistry,
      abi: registryAbi,
      functionName: "register",
      args: [CONTRIBUTION_SCHEMA, zeroAddress, false],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("Schema registration failed");
  }
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        "../contracts/out/GfhBondOperator.sol/GfhBondOperator.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [BASE_SEPOLIA.authCaptureEscrow, BASE_SEPOLIA.eas, schema, [pool]],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Operator deployment failed");
  return {
    operator: receipt.contractAddress,
    schema,
    deploymentBlock: String(receipt.blockNumber),
    transaction: hash,
  };
}
/** Local Anvil funding uses the real USDC mint interface, with an impersonated master minter. */
export async function fundFork(rpcUrl: string, payer: Address, amount: bigint) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const result = (await response.json()) as any;
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  const version = await rpc("web3_clientVersion", []);
  if (!version.toLowerCase().includes("anvil"))
    throw new Error("Fork funding requires Anvil");
  const balance = await client.readContract({
    address: BASE_SEPOLIA.usdc,
    abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
    functionName: "balanceOf",
    args: [payer],
  });
  const mintAmount = amount - balance;
  if (mintAmount < 0n)
    throw new Error("Fork payer already exceeds target balance");
  if (mintAmount === 0n) return;
  const abi = parseAbi([
    "function masterMinter() view returns(address)",
    "function configureMinter(address,uint256) returns(bool)",
    "function mint(address,uint256) returns(bool)",
  ]);
  const minter = await client.readContract({
    address: BASE_SEPOLIA.usdc,
    abi,
    functionName: "masterMinter",
  });
  await rpc("anvil_impersonateAccount", [minter]);
  await rpc("anvil_setBalance", [minter, "0x56BC75E2D63100000"]);
  const wallet = createWalletClient({
    account: minter,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  try {
    for (const [functionName, args] of [
      ["configureMinter", [minter, mintAmount]],
      ["mint", [payer, mintAmount]],
    ] as const) {
      const hash = await wallet.writeContract({
        address: BASE_SEPOLIA.usdc,
        abi,
        functionName,
        args,
      });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("USDC fork funding failed");
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [minter]);
  }
}
