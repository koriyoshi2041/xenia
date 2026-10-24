import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeAbiParameters,
  decodeEventLog,
  toHex,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA, operatorAbi, easAbi, contributionFields, type BondRef } from "@gfh/shared";
import { paymentInfoHash } from "./authorization.ts";
import { saltFor, type PaymentInfo } from "./escrow.ts";
import type { Contribution, Queue } from "@gfh/shared";

export class TransactionReverted extends Error {}

export class Chain {
  public;
  wallet;
  adjudicator;
  communitySigners: Map<string, ReturnType<typeof privateKeyToAccount>>;
  operator: Address;
  constructor(
    rpcUrl: string,
    relayerKey: Hex,
    adjudicatorKey: Hex,
    operator: Address,
    communityKeys: Record<string, Hex> = {},
  ) {
    this.public = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
      pollingInterval: 200,
    });
    this.wallet = createWalletClient({
      account: privateKeyToAccount(relayerKey),
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
    this.adjudicator = privateKeyToAccount(adjudicatorKey);
    this.operator = operator;
    this.communitySigners = new Map(
      Object.entries(communityKeys).map(([repo, key]) => [
        repo,
        privateKeyToAccount(key),
      ]),
    );
  }
  adjudicatorFor(repo: string, requested?: Address) {
    const account = this.communitySigners.get(repo) ?? this.adjudicator;
    if (requested && account.address.toLowerCase() !== requested.toLowerCase())
      throw new Error(`No configured adjudicator for ${repo} at ${requested}`);
    return account;
  }
  signer(address: Address) {
    const account = [this.adjudicator, ...this.communitySigners.values()].find(
      (a) => a.address.toLowerCase() === address.toLowerCase(),
    );
    if (!account)
      throw new Error(`No configured signing key for community ${address}`);
    return account;
  }
  async confirmed(hash: Hex) {
    const receipt = await this.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new TransactionReverted(`Transaction reverted: ${hash}`);
    return receipt;
  }
  /** A pending transaction must not hold up the background reconciliation loop. */
  async receipt(hash: Hex) {
    try {
      const receipt = await this.public.getTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new TransactionReverted(`Transaction reverted: ${hash}`);
      return receipt;
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return undefined;
      throw error;
    }
  }
  async send(
    functionName: string,
    args: readonly unknown[],
    onSent?: (hash: Hex) => void,
  ) {
    const { request } = await this.public.simulateContract({
      address: this.operator,
      abi: operatorAbi as Abi,
      functionName,
      args,
      account: this.wallet.account,
    });
    const hash = await this.wallet.writeContract(request);
    onSent?.(hash);
    return this.confirmed(hash);
  }
  async register(q: Queue) {
    await this.send("registerQueue", [
      "github",
      BigInt(q.repoId),
      q.kind === "pull_requests" ? 0 : 1,
      {
        adjudicator: q.adjudicator,
        pool: q.pool,
        reviewWindow: q.reviewWindow,
        active: true,
      },
    ]);
  }
  post(
    info: PaymentInfo,
    signature: Hex,
    bondRef: BondRef,
    onSent: (hash: Hex) => void,
  ) {
    return this.send(
      "postBond",
      [
        info,
        info.maxAmount,
        BASE_SEPOLIA.erc3009TokenCollector,
        signature,
        bondRef,
      ],
      onSent,
    );
  }
  async resolve(
    info: PaymentInfo | undefined,
    bondRef: BondRef,
    verdict: number,
    slashBps: number,
    reasonCode: number,
    evidenceHash: Hex,
    onSent: (hash: Hex) => void,
    adjudicator: Address = this.adjudicator.address,
  ) {
    const signer = this.signer(adjudicator);
    const domain = {
      name: "Gas for Humans",
      version: "1",
      chainId: 84532,
      verifyingContract: this.operator,
    };
    if (!info) {
      const recipient = "0x0000000000000000000000000000000000000000" as Address;
      const signature = await signer.signTypedData({
        domain,
        primaryType: "Contribution",
        types: {
          Contribution: [
            { name: "refHash", type: "bytes32" },
            { name: "recipient", type: "address" },
            { name: "verdict", type: "uint8" },
            { name: "reasonCode", type: "uint8" },
            { name: "evidenceHash", type: "bytes32" },
          ],
        },
        message: {
          refHash: toHex(saltFor(bondRef), { size: 32 }),
          recipient,
          verdict,
          reasonCode,
          evidenceHash,
        },
      });
      return this.send(
        "recordContribution",
        [bondRef, recipient, verdict, reasonCode, evidenceHash, signature],
        onSent,
      );
    }
    const signature = await signer.signTypedData({
      domain,
      primaryType: "Verdict",
      types: {
        Verdict: [
          { name: "paymentInfoHash", type: "bytes32" },
          { name: "verdict", type: "uint8" },
          { name: "slashBps", type: "uint16" },
          { name: "reasonCode", type: "uint8" },
          { name: "evidenceHash", type: "bytes32" },
        ],
      },
      message: {
        paymentInfoHash: paymentInfoHash(info),
        verdict,
        slashBps,
        reasonCode,
        evidenceHash,
      },
    });
    return this.send(
      "resolve",
      [info, bondRef, verdict, slashBps, reasonCode, evidenceHash, signature],
      onSent,
    );
  }
  expire(info: PaymentInfo, bondRef: BondRef, onSent: (hash: Hex) => void) {
    return this.send("expire", [info, bondRef], onSent);
  }
  async records(receipt: TransactionReceipt): Promise<Contribution[]> {
    const records: Contribution[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.operator.toLowerCase()) continue;
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: operatorAbi,
          topics: log.topics,
          data: log.data,
        });
      } catch {
        continue;
      }
      if (decoded.eventName !== "ContributionRecorded") continue;
      const uid = (decoded.args as { attestationUid: Hex }).attestationUid;
      records.push(
        await this.record(uid, receipt.blockNumber, receipt.transactionHash),
      );
    }
    return records;
  }
  async record(
    uid: Hex,
    blockNumber: bigint,
    txHash: Hex,
  ): Promise<Contribution> {
    const a = await this.public.readContract({
      address: BASE_SEPOLIA.eas,
      abi: easAbi,
      functionName: "getAttestation",
      args: [uid],
    });
    const schema = await this.public.readContract({
      address: this.operator,
      abi: operatorAbi,
      functionName: "VERDICT_SCHEMA",
    });
    if (
      a.attester.toLowerCase() !== this.operator.toLowerCase() ||
      a.schema !== schema ||
      a.uid !== uid ||
      a.revocationTime !== 0n
    )
      throw new Error("Unrecognized contribution attestation");
    const [
      queueId,
      repoId,
      itemNumber,
      githubUserId,
      kind,
      verdict,
      reasonCode,
      bondAmount,
      slashedAmount,
      evidenceHash,
      paymentInfoHash,
    ] = decodeAbiParameters(contributionFields, a.data);
    return {
      uid,
      queueId,
      repoId: Number(repoId),
      itemNumber: Number(itemNumber),
      githubUserId: Number(githubUserId),
      kind: kind === 0 ? "pull_requests" : "security_reports",
      verdict,
      reasonCode,
      bondAmount: String(bondAmount),
      slashedAmount: String(slashedAmount),
      evidenceHash,
      paymentInfoHash,
      recipient: a.recipient,
      recordedAt: Number(a.time),
      blockNumber: String(blockNumber),
      txHash,
    };
  }
  async feedback(
    agentId: bigint,
    verdict: number,
    uri: string,
    hash: Hex,
    endpoint: string,
    onSent: (tx: Hex) => void,
  ) {
    const abi = parseAbi([
      "function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
    ]);
    const value = verdict === 1 ? 1n : verdict === 4 ? -1n : 0n;
    const tag = [
      "None",
      "Accepted",
      "GoodFaith",
      "Downgraded",
      "Spam",
      "Timeout",
    ][verdict]!;
    const request = await this.public.simulateContract({
      address: BASE_SEPOLIA.erc8004Reputation,
      abi,
      functionName: "giveFeedback",
      args: [agentId, value, 0, "gfh:contribution", tag, endpoint, uri, hash],
      account: this.wallet.account,
    });
    const tx = await this.wallet.writeContract(request.request);
    onSent(tx);
    return this.confirmed(tx);
  }
  async balance(address: Address) {
    return this.public.readContract({
      address: BASE_SEPOLIA.usdc,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [address],
    });
  }
}
