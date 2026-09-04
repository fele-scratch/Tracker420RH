const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

function ethToWei(value: number): bigint {
  const [whole, fraction = ""] = value.toString().split(".");
  return BigInt(whole) * WEI_PER_ETH + BigInt(fraction.padEnd(18, "0"));
}

export type AssetTransfer = {
  from?: string;
  to?: string;
  value?: number | string;
  asset?: string;
};

export function isFundAmountInRange(valueWei: bigint, minEth: number, maxEth: number): boolean {
  const minWei = ethToWei(minEth);
  const maxWei = ethToWei(maxEth);
  return valueWei >= minWei && valueWei <= maxWei;
}

export function weiToEth(valueWei: bigint): number {
  return Number(valueWei) / Number(WEI_PER_ETH);
}

export type CandidateRecord = { expiresAt: number };

export function isActiveCandidate(candidates: Map<string, CandidateRecord>, wallet: string, now = Date.now()): boolean {
  const candidate = candidates.get(wallet.toLowerCase());
  return candidate !== undefined && candidate.expiresAt > now;
}

export function firstMeaningfulInboundFrom(transfers: AssetTransfer[], recipient: string): string | null {
  const key = recipient.toLowerCase();
  const first = transfers.find((transfer) => {
    if (transfer.to?.toLowerCase() !== key || !transfer.from) return false;
    if (!ADDRESS.test(transfer.from) || transfer.from.toLowerCase() === ZERO_ADDRESS) return false;
    if (transfer.asset !== undefined && transfer.asset !== "ETH") return false;
    return Number(transfer.value ?? 0) > 0;
  });
  return first?.from?.toLowerCase() ?? null;
}
