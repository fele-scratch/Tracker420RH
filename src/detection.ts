export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC = "0x" + "0".repeat(64);
export const KNOWN_LAUNCH_SELECTORS = new Set(["0x3c05c981", "0x70237117", "0x916d099c"]);

export type ReceiptLike = { status: string; logs: Array<{ address: string; topics: string[] }> };

export function selector(input: string): string {
  return input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x";
}

export function extractMintedTokens(receipt: ReceiptLike): string[] {
  const tokens = new Set<string>();
  for (const item of receipt.logs ?? []) {
    if (item.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (item.topics?.[1]?.toLowerCase() !== ZERO_TOPIC) continue;
    if (/^0x[0-9a-fA-F]{40}$/.test(item.address)) tokens.add(item.address.toLowerCase());
  }
  return [...tokens];
}

export function isSuccessfulReceipt(receipt: ReceiptLike): boolean {
  return receipt.status === "0x1";
}

export function isCandidateLaunch(
  tx: { to: string | null; input: string },
  receipt: ReceiptLike,
  mothership: string,
): boolean {
  if (!isSuccessfulReceipt(receipt)) return false;
  const minted = extractMintedTokens(receipt);
  const isKnownMothershipLaunch = tx.to?.toLowerCase() === mothership.toLowerCase() && KNOWN_LAUNCH_SELECTORS.has(selector(tx.input));
  return minted.length > 0 || isKnownMothershipLaunch;
}

export function candidateWalletFromBundle(
  transaction: { from: string },
  bundleLog: { address: string; topics: string[]; transactionHash: string },
  mothership: string,
  bundleTopic: string,
): string | null {
  if (bundleLog.address.toLowerCase() !== mothership.toLowerCase()) return null;
  if (bundleLog.topics[0]?.toLowerCase() !== bundleTopic.toLowerCase()) return null;
  return transaction.from.toLowerCase();
}
