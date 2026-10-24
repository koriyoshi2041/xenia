import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroAddress, zeroHash } from "viem";
import { DEFAULT_POLICY, type Queue } from "@gfh/shared";
import { openDb } from "../db/index.ts";
import { Store } from "./store.ts";
import type { Item } from "./model.ts";
import { buildPaymentInfo } from "../chain/escrow.ts";

test("the runtime schema reopens queues, payment parameters and sync progress without altering historical data", () => {
  const directory = mkdtempSync(join(tmpdir(), "gfh-store-"));
  let db = openDb(join(directory, "runtime.sqlite"));
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name), ["contributions", "runtime_items", "runtime_meta", "runtime_queues", "webhook_deliveries"]);
    const store = new Store(db);
    const queue: Queue = {
      id: zeroHash, repo: "community/example", repoId: 42, kind: "pull_requests",
      adjudicator: zeroAddress, pool: zeroAddress, reviewWindow: 86400,
      policy: DEFAULT_POLICY, trusts: [], acceptedKinds: ["pull_requests"],
      githubHistory: false, minStars: 10,
    };
    const ref = { queueId: queue.id, itemNumber: 1n, githubUserId: 77n, claimedSeverity: 0, nonce: 123n };
    const item: Item = {
      queueId: queue.id, state: "BONDED", ref,
      pr: { repo: queue.repo, repoId: queue.repoId, number: 1, authorId: 77,
        authorLogin: "contributor", headSha: "abc", url: "https://github.com/community/example/pull/1",
        state: "open", merged: false, labels: [] },
      quote: { amount: 5, exempt: false, blocked: false, reasons: [] },
      payment: buildPaymentInfo({ operator: zeroAddress, payer: zeroAddress,
        pool: zeroAddress, token: zeroAddress, amount: 5_000_000n, ref,
        now: 1_700_000_000, reviewWindowSec: queue.reviewWindow }),
    };
    store.saveQueue(queue);
    store.saveItem(item);
    store.setMeta("index:operator", "12345");
    store.markDelivered("delivery-1");
    // An older installation may retain prototype tables. Opening the database preserves them.
    db.exec("CREATE TABLE queues (id TEXT); INSERT INTO queues VALUES ('historical')");
    db.close();
    db = openDb(join(directory, "runtime.sqlite"));
    const reloaded = new Store(db);
    assert.deepEqual(reloaded.queue(queue.repo), queue);
    assert.deepEqual(reloaded.item(queue.id, 1), item);
    assert.equal(reloaded.meta("index:operator"), "12345");
    assert.equal(reloaded.delivered("delivery-1"), true);
    assert.equal(db.prepare("SELECT id FROM queues").get()?.id, "historical");
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
