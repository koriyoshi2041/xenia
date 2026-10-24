import { BASE_SEPOLIA, passportRecognition, type Passport } from "@gfh/shared";
import type { Service } from "./service.ts";

export async function exportPassport(service: Service, login: string, mode: string): Promise<Passport> {
  const user = await service.github.user(login);
  const block = await service.chain.public.getBlock();
  const communities = service.store.queues();
  const records = service.store.records(user.id);
  return {
    version: "gfh-passport/1", exportedAt: new Date().toISOString(),
    network: {
      mode, chainId: await service.chain.public.getChainId(),
      operator: service.chain.operator, eas: BASE_SEPOLIA.eas,
      anchor: { number: String(block.number), hash: block.hash },
    },
    subject: { githubUserId: user.id, login }, communities, records,
    recognition: passportRecognition(communities, records),
  };
}
