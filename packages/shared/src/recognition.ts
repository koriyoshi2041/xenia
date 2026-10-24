import type { Queue, Contribution, RecognizedContribution } from "./community.ts";

/** Each attestation contributes once, through its strongest admissible path (at most two hops). */
export function trustedRecords(
  target: Queue,
  queues: readonly Queue[],
  records: readonly Contribution[],
): RecognizedContribution[] {
  return records.flatMap((record) => {
    if (!target.acceptedKinds.includes(record.kind)) return [];
    let weight = record.queueId === target.id ? 1 : 0;
    let path = weight ? [target.id] : [];
    for (const edge of target.trusts) {
      if (edge.queueId === record.queueId && edge.weight > weight) {
        weight = edge.weight;
        path = [target.id, edge.queueId];
      }
      const middle = queues.find((q) => q.id === edge.queueId);
      if (!middle?.acceptedKinds.includes(record.kind)) continue;
      for (const next of middle.trusts) {
        const indirect = edge.weight * next.weight * 0.5;
        if (next.queueId === record.queueId && indirect > weight) {
          weight = indirect;
          path = [target.id, middle.id, next.queueId];
        }
      }
    }
    return weight > 0 ? [{ ...record, weight, path }] : [];
  });
}
