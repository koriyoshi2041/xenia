import type { DatabaseSync } from "node:sqlite";
import type { Queue, Contribution } from "@gfh/shared";
import { hydrateItem, json, type Item } from "./model.ts";

export class Store {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  queues(): Queue[] {
    return this.db
      .prepare("SELECT data FROM runtime_queues ORDER BY repo")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  queue(repoOrId: string) {
    return this.queues().find((q) => q.id === repoOrId || q.repo === repoOrId);
  }
  saveQueue(q: Queue) {
    this.db
      .prepare(
        "INSERT INTO runtime_queues VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,data=excluded.data",
      )
      .run(q.id, q.repo, json(q));
  }
  item(queueId: string, number: number): Item | undefined {
    const row = this.db
      .prepare("SELECT data FROM runtime_items WHERE queue_id=? AND number=?")
      .get(queueId, number);
    return row ? hydrateItem(row.data as string) : undefined;
  }
  items(): Item[] {
    return this.db
      .prepare("SELECT data FROM runtime_items")
      .all()
      .map((r) => hydrateItem(r.data as string));
  }
  saveItem(i: Item) {
    this.db
      .prepare(
        "INSERT INTO runtime_items VALUES (?,?,?) ON CONFLICT(queue_id,number) DO UPDATE SET data=excluded.data",
      )
      .run(i.queueId, i.pr.number, json(i));
  }
  records(githubId?: number): Contribution[] {
    const rows =
      githubId === undefined
        ? this.db.prepare("SELECT data FROM contributions").all()
        : this.db
            .prepare("SELECT data FROM contributions WHERE github_id=?")
            .all(githubId);
    return rows.map((r) => JSON.parse(r.data as string));
  }
  saveRecord(r: Contribution) {
    this.db
      .prepare("INSERT OR IGNORE INTO contributions VALUES (?,?,?)")
      .run(r.uid, r.githubUserId, json(r));
  }
  meta(key: string) {
    return this.db
      .prepare("SELECT value FROM runtime_meta WHERE key=?")
      .get(key)?.value as string | undefined;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO runtime_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  delivered(id: string) {
    return Boolean(
      this.db.prepare("SELECT 1 FROM webhook_deliveries WHERE id=?").get(id),
    );
  }
  markDelivered(id: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO webhook_deliveries VALUES (?)")
      .run(id);
  }
}
