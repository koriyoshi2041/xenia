import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { isAddress, type Address } from "viem";
import { BASE_SEPOLIA, Verdict, type NetworkSnapshot } from "@gfh/shared";
import { Service } from "./service.ts";
import { json } from "./model.ts";
import { pullFromPayload } from "../github/client.ts";
import { encodePaymentHeader } from "../x402/bond.ts";
import { exportPassport } from "./passport.ts";

export function createHttp(
  service: Service,
  options: { adminToken: string; webhookSecret: string; mode: string },
) {
  const app = new Hono();
  const response = (c: any, value: unknown, status = 200) =>
    c.newResponse(json(value), status, { "Content-Type": "application/json" });
  const authorized = (c: any) =>
    c.req.header("authorization") === `Bearer ${options.adminToken}`;
  app.onError((error, c) => response(c, { error: error.message }, 400));
  app.get("/healthz", async (c) =>
    response(c, {
      ok: true,
      mode: options.mode,
      chainId: await service.chain.public.getChainId(),
      operator: service.chain.operator,
      blockNumber: String(await service.chain.public.getBlockNumber()),
    }),
  );
  app.get("/api/queues", (c) =>
    response(c, { queues: service.store.queues() }),
  );
  app.post("/api/queues", async (c) => {
    if (!authorized(c))
      return response(c, { error: "Operator authorization required" }, 401);
    const q = await c.req.json();
    return response(c, await service.serial(() => service.register(q)), 201);
  });
  app.post("/api/queues/:id/policy-challenge", async (c) => {
    const patch = await c.req.json();
    return response(
      c,
      await service.policyChallenge(service.queue(c.req.param("id")), patch),
    );
  });
  app.patch("/api/queues/:id/policy", async (c) => {
    const input = await c.req.json();
    return response(
      c,
      await service.serial(() =>
        service.updatePolicy(service.queue(c.req.param("id")), input),
      ),
    );
  });
  app.get("/api/review-queue", (c) =>
    response(c, { items: service.reviewQueue(c.req.query("repo")) }),
  );
  app.get("/api/contributions", (c) => {
    const repo = c.req.query("repo");
    const queueId = repo ? service.queue(repo).id : undefined;
    return response(c, {
      items: service.store
        .items()
        .filter((i) => !queueId || i.queueId === queueId),
    });
  });
  app.get("/api/quote", async (c) =>
    response(
      c,
      await service.quote(
        c.req.query("repo") ?? "",
        c.req.query("login") ?? "",
      ),
    ),
  );
  app.get("/api/participation", async (c) =>
    response(
      c,
      await service.prepareContribution(
        c.req.query("repo") ?? "",
        c.req.query("login") ?? "",
      ),
    ),
  );
  app.post("/api/items/:owner/:repo/:number/sync", async (c) =>
    response(
      c,
      await service.serial(() =>
        service.sync(
          `${c.req.param("owner")}/${c.req.param("repo")}`,
          Number(c.req.param("number")),
        ),
      ),
    ),
  );
  app.get("/api/items/:owner/:repo/:number", (c) =>
    response(
      c,
      service.item(
        `${c.req.param("owner")}/${c.req.param("repo")}`,
        Number(c.req.param("number")),
      ),
    ),
  );
  app.post("/api/bonds/:owner/:repo/:number", async (c) => {
    return service.serial(async () => {
      const item = service.item(
        `${c.req.param("owner")}/${c.req.param("repo")}`,
        Number(c.req.param("number")),
      );
      await service.recoverPendingBond(item);
      const signed = c.req.header("payment-signature");
      if (signed) {
        const result = await service.pay(
          item,
          JSON.parse(Buffer.from(signed, "base64").toString("utf8")),
        );
        c.header(
          "PAYMENT-RESPONSE",
          encodePaymentHeader({
            success: true,
            transaction: result.txPost,
            network: BASE_SEPOLIA.network,
            payer: result.payment?.payer,
          }),
        );
        return response(c, result);
      }
      if (item.state !== "AWAITING_BOND") return response(c, item);
      const body = await c.req.json();
      if (!isAddress(body.payer))
        throw new Error("A payer address is required");
      const required = await service.challenge(
        item,
        body.payer as Address,
        body.agentId,
      );
      if (item.state !== "AWAITING_BOND") return response(c, item);
      c.header("PAYMENT-REQUIRED", encodePaymentHeader(required));
      return response(c, required, 402);
    });
  });
  app.post("/api/items/:owner/:repo/:number/expire", async (c) =>
    response(
      c,
      await service.serial(() =>
        service.resolve(
          service.item(
            `${c.req.param("owner")}/${c.req.param("repo")}`,
            Number(c.req.param("number")),
          ),
          Verdict.Timeout,
        ),
      ),
    ),
  );
  app.get("/api/records/:login", async (c) => {
    const user = await service.github.user(c.req.param("login"));
    return response(c, {
      githubUserId: user.id,
      records: service.store.records(user.id),
    });
  });
  app.get("/api/passports/:login", async (c) =>
    response(c, await service.serial(() => exportPassport(service, c.req.param("login"), options.mode))),
  );
  app.get("/api/attestations/:uid", (c) => {
    const record = service.store
      .records()
      .find((r) => r.uid === c.req.param("uid"));
    return record
      ? response(c, record)
      : response(c, { error: "Attestation not indexed" }, 404);
  });
  app.get("/api/network", (c) =>
    response(c, {
      queues: service.store.queues(),
      records: service.store.records(),
      runtime: {
        mode: options.mode,
        chainId: BASE_SEPOLIA.chainId,
        operator: service.chain.operator,
      },
    } satisfies NetworkSnapshot),
  );
  app.post("/webhooks/github", async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", options.webhookSecret).update(raw).digest("hex")}`;
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return response(c, { error: "Invalid webhook signature" }, 401);
    const delivery = c.req.header("x-github-delivery");
    if (!delivery) return response(c, { error: "Missing delivery id" }, 400);
    const event = c.req.header("x-github-event");
    const payload = JSON.parse(raw);
    return service.serial(async () => {
      if (service.store.delivered(delivery))
        return response(c, { ok: true, duplicate: true });
      if (
        event === "pull_request" &&
        [
          "opened",
          "reopened",
          "synchronize",
          "closed",
          "labeled",
          "unlabeled",
          "ready_for_review",
          "converted_to_draft",
        ].includes(payload.action)
      ) {
        if (service.store.queue(payload.repository.full_name))
          await service.ingest(
            pullFromPayload(
              payload.repository.full_name,
              payload.repository.id,
              payload.pull_request,
            ),
          );
      }
      service.store.markDelivered(delivery);
      return response(c, { ok: true });
    });
  });
  return app;
}
