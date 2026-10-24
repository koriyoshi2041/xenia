// Base Sepolia (chain id 84532). Bytecode of each address checked on 2026-10-23.

export const BASE_SEPOLIA = {
  chainId: 84532,
  network: "eip155:84532",
  rpcUrl: "https://sepolia.base.org",
  /** base/commerce-payments v1.1, audited (Spearbit, Coinbase Protocol Security). */
  authCaptureEscrow: "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
  erc3009TokenCollector: "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88",
  permit2TokenCollector: "0xD69831Aed5bfe262067ec4c751f4F830EcdD446e",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // EIP-712 domain: name "USDC", version "2"
  eas: "0x4200000000000000000000000000000000000021",
  easSchemaRegistry: "0x4200000000000000000000000000000000000020",
  erc8004Identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  erc8004Reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
} as const;
