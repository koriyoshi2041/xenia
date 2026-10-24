import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  stringToHex,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  BASE_SEPOLIA,
  Verdict,
  agentIdentity,
  communityPolicyTypedData,
  quote,
  participationBrief,
  DEFAULT_POLICY,
  operatorAbi,
  trustedRecords,
  type Queue,
  type PullRequest,
  type CommunityQuote,
} from "@gfh/shared";
import { Chain, TransactionReverted } from "../chain/client.ts";
import { buildPaymentInfo } from "../chain/escrow.ts";
import { erc3009TypedData, paymentInfoHash } from "../chain/authorization.ts";
import { paymentRequirements } from "../x402/bond.ts";
import { Store } from "./store.ts";
import { json, type Item } from "./model.ts";
import type { GitHubGateway } from "../github/client.ts";

export class Service {
  store: Store;
  chain: Chain;
  github: GitHubGateway;
  baseUrl: string;
  private work: Promise<unknown> = Promise.resolve();
  constructor(
    store: Store,
    chain: Chain,
    github: GitHubGateway,
    baseUrl: string,
  ) {
    this.store = store;
    this.chain = chain;
    this.github = github;
    this.baseUrl = baseUrl;
  }
  // Serialize mutation transactions from this relayer; reads remain concurrent.
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.work.then(fn, fn);
    this.work = next.catch(() => {});
    return next;
  }
  queue(repo: string) {
    const q = this.store.queue(repo);
    if (!q) throw new Error(`Queue not registered: ${repo}`);
    return q;
  }
  async register(
    input: Partial<Queue> & Pick<Queue, "repo" | "repoId" | "pool">,
  ) {
    if (this.store.queue(input.repo))
      throw new Error("Queue already registered");
    const kind = input.kind ?? "pull_requests";
    const id = keccak256(
      encodeAbiParameters(parseAbiParameters("string,uint64,uint8"), [
        "github",
        BigInt(input.repoId),
        kind === "pull_requests" ? 0 : 1,
      ]),
    );
    const q: Queue = {
      id,
      repo: input.repo,
      repoId: input.repoId,
      kind,
      pool: input.pool,
      adjudicator: this.chain.adjudicatorFor(input.repo, input.adjudicator)
        .address,
      policyRevision: 0,
      reviewWindow: input.reviewWindow ?? 14 * 86400,
      policy: { ...DEFAULT_POLICY, ...input.policy },
      trusts: input.trusts ?? [],
      acceptedKinds: input.acceptedKinds ?? [kind],
      githubHistory: input.githubHistory ?? true,
      minStars: input.minStars ?? 10,
    };
    await this.chain.register(q);
    this.store.saveQueue(q);
    return q;
  }
  reviewQueue(repo?: string) {
    const queueId = repo ? this.queue(repo).id : undefined;
    return this.store
      .items()
      .filter(
        (i) =>
          (!queueId || i.queueId === queueId) &&
          i.pr.state === "open" &&
          !i.pr.draft &&
          ["BONDED", "EXEMPT"].includes(i.state),
      )
      .sort((a, b) => (a.admittedAt ?? "").localeCompare(b.admittedAt ?? ""));
  }
  policyDocument(queue: Queue, patch: Partial<Queue>) {
    const trusts = patch.trusts ?? queue.trusts;
    const acceptedKinds = patch.acceptedKinds ?? queue.acceptedKinds;
    if (
      !Array.isArray(trusts) ||
      trusts.some(
        (e) =>
          !this.store.queue(e.queueId) ||
          e.queueId === queue.id ||
          !Number.isFinite(e.weight) ||
          e.weight < 0 ||
          e.weight > 1,
      )
    )
      throw new Error(
        "Trust edges require another registered queue and a weight from 0 to 1",
      );
    if (new Set(trusts.map((e) => e.queueId)).size !== trusts.length)
      throw new Error("Duplicate trust edge");
    if (
      !Array.isArray(acceptedKinds) ||
      !acceptedKinds.length ||
      acceptedKinds.some(
        (k) => !["pull_requests", "security_reports"].includes(k),
      )
    )
      throw new Error("Select valid contribution kinds");
    const policy = { ...queue.policy, ...patch.policy };
    for (const value of [
      policy.baseBond,
      policy.exemptMinRecords,
      policy.oneRecordMultiplier,
      policy.concurrency.freeOpen,
      policy.concurrency.multiplier,
      policy.perSlashMultiplier,
      policy.maxSlashMultiplier,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new Error("Policy amounts must be non-negative numbers");
    if (
      policy.exemptMinRecords < 1 ||
      !Array.isArray(policy.youngAccount) ||
      policy.youngAccount.some(
        (r) =>
          !Number.isFinite(r.days) ||
          !Number.isFinite(r.multiplier) ||
          r.days < 0 ||
          r.multiplier < 0,
      )
    )
      throw new Error("Invalid history or age policy");
    if (
      policy.denounced !== "block" &&
      (!Number.isFinite(policy.denounced?.multiplier) ||
        policy.denounced.multiplier < 0)
    )
      throw new Error("Invalid denouncement multiplier");
    return { trusts, acceptedKinds, policy };
  }
  async policyChallenge(queue: Queue, patch: Partial<Queue>) {
    const document = this.policyDocument(queue, patch);
    const expiresAt =
      Number((await this.chain.public.getBlock()).timestamp) + 600;
    const revision = (queue.policyRevision ?? 0) + 1;
    return {
      document,
      revision,
      expiresAt,
      signer: queue.adjudicator,
      typedData: communityPolicyTypedData(
        this.chain.operator,
        queue.id,
        document,
        revision,
        expiresAt,
      ),
    };
  }
  async updatePolicy(
    queue: Queue,
    input: {
      document: Partial<Queue>;
      revision: number;
      expiresAt: number;
      signature: Hex;
    },
  ) {
    const document = this.policyDocument(queue, input.document);
    if (input.revision !== (queue.policyRevision ?? 0) + 1)
      throw new Error("Community policy changed; request a fresh signature");
    const now = Number((await this.chain.public.getBlock()).timestamp);
    if (input.expiresAt < now || input.expiresAt > now + 900)
      throw new Error("Policy signature has expired");
    const typed = communityPolicyTypedData(
      this.chain.operator,
      queue.id,
      document,
      input.revision,
      input.expiresAt,
    );
    if (
      !(await this.chain.public.verifyTypedData({
        ...typed,
        address: queue.adjudicator,
        signature: input.signature,
      }))
    )
      throw new Error(
        "This policy must be signed by the community adjudicator",
      );
    Object.assign(queue, document, {
      policyRevision: input.revision,
      policyProof: {
        signature: input.signature,
        expiresAt: input.expiresAt,
        signer: queue.adjudicator,
        hash: typed.message.policyHash,
      },
    });
    this.store.saveQueue(queue);
    return queue;
  }
  async quote(repo: string, login: string, excludeNumber?: number): Promise<CommunityQuote> {
    const q = this.queue(repo);
    const user = await this.github.user(login);
    const recognized = trustedRecords(
      q,
      this.store.queues(),
      this.store.records(user.id),
    );
    const history = q.githubHistory
      ? await this.github.signals(repo, login, q.minStars)
      : { write: false, merged: [] };
    // A merge represented by EAS and GitHub history is one contribution.
    const onchainKeys = new Set(
      recognized
        .filter((r) => r.verdict === Verdict.Accepted)
        .map((r) => `${this.store.queue(r.queueId)?.repo}#${r.itemNumber}`),
    );
    const historic = history.merged.filter(
      (r) => !onchainKeys.has(`${r.repo}#${r.number}`),
    );
    const credits =
      recognized
        .filter((r) => r.verdict === Verdict.Accepted)
        .reduce((sum, r) => sum + r.weight, 0) + historic.length;
    const recentSlashes = recognized.filter(
      (r) =>
        r.verdict === Verdict.Spam &&
        (r.recordedAt ?? 0) >= Date.now() / 1000 - 180 * 86400,
    ).length;
    const result = quote(
      {
        isInfraBot: login === "dependabot[bot]" || login === "renovate[bot]",
        hasWriteAccess: history.write,
        vouched: false,
        denounced: false,
        records: credits,
        recentSlashes,
        accountAgeDays: (Date.now() - Date.parse(user.createdAt)) / 86400000,
        openInQueue: this.store
          .items()
          .filter(
            (i) =>
              i.queueId === q.id &&
              i.pr.authorId === user.id &&
              i.pr.number !== excludeNumber &&
              ["BONDED", "EXEMPT", "AWAITING_BOND"].includes(i.state),
          ).length,
      },
      q.policy,
    );
    return {
      ...result,
      credits,
      recognized,
      historical: historic,
      githubUserId: user.id,
    };
  }
  async prepareContribution(repo: string, login: string) {
    const community = this.queue(repo);
    return participationBrief(community, await this.quote(repo, login));
  }
  async ingest(pr: PullRequest) {
    const q = this.queue(pr.repo);
    if (q.repoId !== pr.repoId) throw new Error("Repository id mismatch");
    let item = this.store.item(q.id, pr.number);
    if (item) await this.recoverPendingBond(item);
    const reopened = item && pr.state === "open" && item.pr.state === "closed" &&
      (item.state === "RESOLVED" || (item.state === "CLOSED_UNBONDED" && !item.txPost));
    if (!item || reopened) {
      const previousRounds = item ? [...(item.previousRounds ?? []), {
        queueId: item.queueId, pr: item.pr, state: item.state,
        quote: item.quote, admittedAt: item.admittedAt,
        txPost: item.txPost, txResolve: item.txResolve,
        verdict: item.verdict, attestation: item.attestation,
      }] : undefined;
      const pricing = await this.quote(pr.repo, pr.authorLogin, pr.number);
      item = {
        queueId: q.id,
        pr,
        state: pricing.exempt ? "EXEMPT" : "AWAITING_BOND",
        quote: pricing,
        previousRounds,
        ref: {
          queueId: q.id,
          itemNumber: BigInt(pr.number),
          githubUserId: BigInt(pr.authorId),
          claimedSeverity: 0,
          nonce: BigInt(`0x${randomBytes(12).toString("hex")}`),
        },
      };
    }
    // An in-flight deposit keeps its original reference when the PR reopens.
    if (pr.state === "open" && item.state === "CLOSED_UNBONDED")
      item.state = item.quote.exempt ? "EXEMPT" : "AWAITING_BOND";
    item.pr = pr;
    if (item.state === "EXEMPT" && !item.admittedAt)
      item.admittedAt = new Date().toISOString();
    this.store.saveItem(item);
    if (
      pr.state === "closed" &&
      item.state !== "RESOLVED" &&
      item.state !== "CLOSED_UNBONDED"
    ) {
      if (item.state === "AWAITING_BOND") {
        item.state = "CLOSED_UNBONDED";
        this.store.saveItem(item);
      } else await this.resolve(item, this.closingVerdict(item));
    }
    await this.github.check(
      pr,
      ["BONDED", "EXEMPT", "RESOLVED"].includes(item.state),
      item.state === "AWAITING_BOND"
        ? `${item.quote.amount} USDC refundable commitment. ${this.baseUrl}/api/items/${pr.repo}/${pr.number}`
        : item.attestation
          ? `Contribution attested: ${item.attestation}`
          : "Review commitment satisfied.",
    );
    return item;
  }
  async sync(repo: string, number: number) {
    return this.ingest(await this.github.pull(repo, number));
  }
  item(repo: string, number: number) {
    const item = this.store.item(this.queue(repo).id, number);
    if (!item) throw new Error("Pull request not synced");
    return item;
  }
  async challenge(item: Item, payer: Address, agentId?: string) {
    await this.recoverPendingBond(item);
    if (item.quote.blocked)
      throw new Error("Contribution blocked by queue policy");
    if (item.state !== "AWAITING_BOND") return { item };
    if (agentId) {
      const identity = await agentIdentity(
        BigInt(agentId),
        this.chain.public.transport.url,
      );
      if (
        ![identity.owner.toLowerCase(), identity.wallet.toLowerCase()].includes(
          payer.toLowerCase(),
        )
      )
        throw new Error("Payer does not control this ERC-8004 identity");
      item.agentId = agentId;
    }
    const now = Number((await this.chain.public.getBlock()).timestamp);
    if (
      !item.payment ||
      item.payment.preApprovalExpiry <= now ||
      item.payment.payer.toLowerCase() !== payer.toLowerCase()
    ) {
      if (item.txPost)
        throw new Error("Payment transaction pending confirmation");
      item.payment = buildPaymentInfo({
        operator: this.chain.operator,
        payer,
        pool: this.queue(item.queueId).pool,
        token: BASE_SEPOLIA.usdc,
        amount: parseUnits(String(item.quote.amount), 6),
        ref: item.ref,
        now,
        reviewWindowSec: this.queue(item.queueId).reviewWindow,
      });
      const req = paymentRequirements(
        item.payment,
        item.payment.maxAmount,
        `${this.baseUrl}/api/bonds/${item.pr.repo}/${item.pr.number}`,
      );
      item.requirements = {
        ...req,
        extensions: {
          "gfh-contribution": {
            info: {
              ref: JSON.parse(json(item.ref)),
              paymentInfo: JSON.parse(json(item.payment)),
            },
            schema: { type: "object", required: ["ref", "paymentInfo"] },
          },
        },
      };
      this.store.saveItem(item);
    }
    return item.requirements;
  }
  async pay(item: Item, payload: any) {
    await this.recoverPendingBond(item);
    if (item.state === "BONDED" || item.state === "RESOLVED") return item;
    if (item.state !== "AWAITING_BOND" || !item.payment || !item.requirements)
      throw new Error("Request a payment challenge first");
    const req = item.requirements as any;
    const info = item.payment;
    const typed = erc3009TypedData(info);
    if (
      payload.x402Version !== 2 ||
      json(payload.accepted) !== json(req.accepts[0]) ||
      json(payload.extensions) !== json(req.extensions) ||
      payload.payload?.salt !== toHex(info.salt, { size: 32 })
    )
      throw new Error("Payment requirements or contribution binding changed");
    if (
      json(payload.payload.authorization) !==
      json(JSON.parse(json(typed.message)))
    )
      throw new Error("Authorization does not match quote");
    if (
      !(await this.chain.public.verifyTypedData({
        ...typed,
        address: info.payer,
        signature: payload.payload.signature,
      }))
    )
      throw new Error("Invalid payer signature");
    let receipt;
    try {
      receipt = item.txPost
        ? await this.chain.confirmed(item.txPost)
        : await this.chain.post(
            info,
            payload.payload.signature,
            item.ref,
            (tx) => {
              item.txPost = tx;
              this.store.saveItem(item);
            },
          );
    } catch (error) {
      if (error instanceof TransactionReverted) {
        delete item.txPost;
        this.store.saveItem(item);
      }
      throw error;
    }
    await this.admitBond(item, receipt.transactionHash);
    return item;
  }
  private async admitBond(item: Item, transactionHash: Hex) {
    item.txPost = transactionHash;
    item.state = "BONDED";
    item.admittedAt = new Date().toISOString();
    item.paymentHash = paymentInfoHash(item.payment!);
    this.store.saveItem(item);
    await this.github.check(
      item.pr,
      true,
      `Review commitment confirmed in ${transactionHash}.`,
    );
  }
  async recoverPendingBond(item: Item) {
    if (!item.txPost || !item.payment ||
        !["AWAITING_BOND", "CLOSED_UNBONDED"].includes(item.state)) return;
    let receipt;
    try {
      receipt = await this.chain.receipt(item.txPost);
    } catch (error) {
      if (!(error instanceof TransactionReverted)) throw error;
      delete item.txPost;
      this.store.saveItem(item);
      return;
    }
    if (!receipt) return;
    await this.admitBond(item, receipt.transactionHash);
    if (item.pr.state === "closed") await this.reconcileBond(item);
  }
  async reconcileBond(item: Item, now?: number) {
    if (item.state !== "BONDED" || !item.paymentHash) return;
    const bond = await this.chain.public.readContract({
      address: this.chain.operator,
      abi: operatorAbi,
      functionName: "bonds",
      args: [item.paymentHash],
    });
    if (bond[6]) {
      const record = this.store.records(item.pr.authorId)
        .find((r) => r.paymentInfoHash === item.paymentHash);
      if (record) {
        item.state = "RESOLVED";
        item.verdict = record.verdict;
        item.attestation = record.uid;
        item.txResolve = record.txHash;
        this.store.saveItem(item);
      }
      return;
    }
    now ??= Number((await this.chain.public.getBlock()).timestamp);
    if (Number(bond[3]) <= now) await this.resolve(item, Verdict.Timeout);
    else if (item.pr.state === "closed")
      await this.resolve(item, this.closingVerdict(item));
  }
  closingVerdict(item: Item) {
    return item.pr.merged ? Verdict.Accepted
      : item.pr.labels.includes("gfh:spam") ? Verdict.Spam : Verdict.GoodFaith;
  }
  async resolve(
    item: Item,
    verdict: number,
    slashBps = verdict === Verdict.Spam ? 10000 : 0,
  ) {
    if (item.state === "RESOLVED") return item;
    if (!["BONDED", "EXEMPT"].includes(item.state))
      throw new Error("Item is not admitted");
    const evidenceHash = keccak256(
      stringToHex(
        json({
          url: item.pr.url,
          headSha: item.pr.headSha,
          merged: item.pr.merged,
          labels: [...item.pr.labels].sort(),
          verdict,
        }),
      ),
    );
    const sent = (tx: Hex) => {
      item.txResolve = tx;
      this.store.saveItem(item);
    };
    let receipt;
    try {
      receipt = item.txResolve
        ? await this.chain.confirmed(item.txResolve)
        : verdict === Verdict.Timeout && item.payment
          ? await this.chain.expire(item.payment, item.ref, sent)
          : await this.chain.resolve(
              item.payment,
              item.ref,
              verdict,
              slashBps,
              0,
              evidenceHash,
              sent,
              this.queue(item.queueId).adjudicator,
            );
    } catch (error) {
      if (error instanceof TransactionReverted) {
        delete item.txResolve;
        this.store.saveItem(item);
      }
      throw error;
    }
    const records = await this.chain.records(receipt);
    if (records.length !== 1)
      throw new Error("Confirmed settlement has no contribution proof");
    for (const r of records) this.store.saveRecord(r);
    item.state = "RESOLVED";
    item.verdict = records[0]!.verdict;
    item.attestation = records[0]!.uid;
    this.store.saveItem(item);
    await this.feedback(item);
    return item;
  }
  async feedback(item: Item) {
    if (
      !item.agentId ||
      !item.txPost ||
      !item.attestation ||
      item.feedbackConfirmed
    )
      return;
    try {
      if (item.feedbackTx) await this.chain.confirmed(item.feedbackTx);
      else {
        const record = this.store
          .records(item.pr.authorId)
          .find((r) => r.uid === item.attestation)!;
        await this.chain.feedback(
          BigInt(item.agentId),
          record.verdict,
          `data:application/json;base64,${Buffer.from(json(record)).toString("base64")}`,
          keccak256(stringToHex(json(record))),
          item.pr.url,
          (tx) => {
            item.feedbackTx = tx;
            this.store.saveItem(item);
          },
        );
      }
      item.feedbackConfirmed = true;
      delete item.feedbackError;
    } catch (error) {
      if (error instanceof TransactionReverted) delete item.feedbackTx;
      item.feedbackError = (error as Error).message;
    }
    this.store.saveItem(item);
  }
}
