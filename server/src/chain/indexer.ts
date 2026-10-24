import { parseAbiItem } from "viem";
import type { Service } from "../runtime/service.ts";

/** Resume from a durable block cursor, and verify each record against EAS before indexing it. */
export async function indexContributions(service: Service, fromBlock = 0n) {
  const key = `index:${service.chain.operator.toLowerCase()}`;
  let from = BigInt(service.store.meta(key) ?? String(fromBlock));
  const latest = await service.chain.public.getBlockNumber();
  // A restored local chain can be behind a cursor saved by a previous run.
  if (from > latest + 1n) from = fromBlock;
  while (from <= latest) {
    // The public Base Sepolia RPC accepts at most 200 blocks per log request.
    const to = from + 199n < latest ? from + 199n : latest;
    const logs = await service.chain.public.getLogs({
      address: service.chain.operator,
      event: parseAbiItem(
        "event ContributionRecorded(bytes32 indexed queueId,uint64 indexed githubUserId,bytes32 indexed attestationUid,uint64 itemNumber,uint8 verdict,bytes32 paymentInfoHash)",
      ),
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      if (
        log.args.attestationUid &&
        log.blockNumber !== null &&
        log.transactionHash
      )
        service.store.saveRecord(
          await service.chain.record(
            log.args.attestationUid,
            log.blockNumber,
            log.transactionHash,
          ),
        );
    }
    from = to + 1n;
    service.store.setMeta(key, String(from));
  }
}
export async function syncChainState(service: Service, fromBlock: bigint) {
  await indexContributions(service, fromBlock);
  const now = Number((await service.chain.public.getBlock()).timestamp);
  for (const item of service.store.items()) {
    await service.recoverPendingBond(item);
    await service.reconcileBond(item, now);
    if (item.state === "RESOLVED") await service.feedback(item);
  }
}
export function startIndexer(service: Service, fromBlock: bigint): () => void {
  const tick = () =>
    service
      .serial(() => syncChainState(service, fromBlock))
      .catch((e) => console.error("Chain sync:", e.message));
  void tick();
  const timer = setInterval(tick, 15000);
  return () => clearInterval(timer);
}
