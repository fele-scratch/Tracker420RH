export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC = "0x" + "0".repeat(64);
export const PONS_LAUNCH_EVENT_TOPIC = "0x15de155d60524b3ee39fdb5a912aa3e8014858ffc9915be9c0ffc18fae66b486";

export type LaunchLog = { address: string; topics?: string[]; data?: string };
export type LaunchReceipt = { status: string; contractAddress?: string | null; logs?: LaunchLog[] };
export type TraceFrame = { type?: string; to?: string; result?: { address?: string }; calls?: TraceFrame[] };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]*$/;

export type LaunchAndBuyArgs = { recipient: string; exemptions: string[] };

export function selector(input: string): string {
  return input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x";
}

export function decodeLaunchAndBuyArgs(input: string, minExemptions = 25, maxExemptions = 32): LaunchAndBuyArgs | null {
  if (selector(input) !== "0xf85f8e41" || !WORD.test(input)) return null;
  const args = input.slice(10);
  const word = (index: number): string | null => {
    const value = args.slice(index * 64, index * 64 + 64);
    return value.length === 64 ? value : null;
  };
  const recipientWord = word(5);
  const exemptionsOffsetWord = word(6);
  if (!recipientWord || !exemptionsOffsetWord) return null;
  const recipient = `0x${recipientWord.slice(24)}`.toLowerCase();
  if (!ADDRESS.test(recipient)) return null;
  const exemptionsOffset = Number.parseInt(exemptionsOffsetWord, 16) * 2;
  if (!Number.isSafeInteger(exemptionsOffset)) return null;
  const countWord = args.slice(exemptionsOffset, exemptionsOffset + 64);
  if (countWord.length !== 64) return null;
  const count = Number.parseInt(countWord, 16);
  if (!Number.isSafeInteger(count) || count < minExemptions || count > maxExemptions) return null;
  const exemptions: string[] = [];
  for (let index = 0; index < count; index++) {
    const value = args.slice(exemptionsOffset + 64 + index * 64, exemptionsOffset + 128 + index * 64);
    if (value.length !== 64) return null;
    const address = `0x${value.slice(24)}`.toLowerCase();
    if (!ADDRESS.test(address)) return null;
    exemptions.push(address);
  }
  return { recipient, exemptions };
}

export function isSuccessful(receipt: LaunchReceipt): boolean {
  return receipt.status === "0x1";
}

export function extractZeroAddressMints(receipt: LaunchReceipt): string[] {
  const tokens = new Set<string>();
  for (const item of receipt.logs ?? []) {
    if (item.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (item.topics?.[1]?.toLowerCase() !== ZERO_TOPIC) continue;
    if (ADDRESS.test(item.address)) tokens.add(item.address.toLowerCase());
  }
  return [...tokens];
}

export function extractPonsInitialPoolCandidates(receipt: LaunchReceipt, tokenAddresses: string[] = extractZeroAddressMints(receipt)): string[] {
  const tokens = new Set(tokenAddresses.map((address) => address.toLowerCase()));
  const pools = new Set<string>();
  for (const item of receipt.logs ?? []) {
    if (!tokens.has(item.address.toLowerCase())) continue;
    if (item.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (item.topics?.[1]?.toLowerCase() !== ZERO_TOPIC) continue;
    const recipient = item.topics[2]?.slice(-40);
    if (recipient && ADDRESS.test(`0x${recipient}`)) pools.add(`0x${recipient}`.toLowerCase());
  }
  return [...pools];
}

function addressesFromWord(word: string): string[] {
  if (!WORD.test(word)) return [];
  const hex = word.slice(2);
  const result: string[] = [];
  for (let offset = 0; offset + 64 <= hex.length; offset += 64) {
    const chunk = hex.slice(offset, offset + 64);
    const candidate = `0x${chunk.slice(24)}`;
    if (ADDRESS.test(candidate) && candidate !== "0x" + "0".repeat(40)) result.push(candidate.toLowerCase());
  }
  return result;
}

export function extractPonsLaunchTokenCandidates(receipt: LaunchReceipt): string[] {
  const tokens = new Set<string>();
  for (const item of receipt.logs ?? []) {
    if (item.topics?.[0]?.toLowerCase() !== PONS_LAUNCH_EVENT_TOPIC) continue;
    const firstWord = (item.data ?? "").slice(0, 66);
    for (const address of addressesFromWord(firstWord)) tokens.add(address);
  }
  return [...tokens];
}

export function extractAddressCandidates(receipt: LaunchReceipt): string[] {
  const candidates = new Set<string>();
  if (receipt.contractAddress && ADDRESS.test(receipt.contractAddress)) candidates.add(receipt.contractAddress.toLowerCase());
  for (const item of receipt.logs ?? []) {
    if (ADDRESS.test(item.address)) candidates.add(item.address.toLowerCase());
    for (const topic of item.topics ?? []) for (const address of addressesFromWord(topic)) candidates.add(address);
    for (const address of addressesFromWord(item.data ?? "")) candidates.add(address);
  }
  return [...candidates];
}

export function extractTraceAddresses(trace: TraceFrame | TraceFrame[] | null | undefined): string[] {
  const addresses = new Set<string>();
  const visit = (frame: TraceFrame): void => {
    if (frame.to && ADDRESS.test(frame.to)) addresses.add(frame.to.toLowerCase());
    if (frame.result?.address && ADDRESS.test(frame.result.address)) addresses.add(frame.result.address.toLowerCase());
    for (const child of frame.calls ?? []) visit(child);
  };
  for (const frame of Array.isArray(trace) ? trace : trace ? [trace] : []) visit(frame);
  return [...addresses];
}

export function hasLaunchEvidence(
  receipt: LaunchReceipt,
  trace?: TraceFrame | TraceFrame[] | null,
  context?: { destination?: string | null; inputSelector?: string; mothership?: string; launchSelectors?: Set<string> },
): boolean {
  if (!isSuccessful(receipt)) return false;
  if (extractZeroAddressMints(receipt).length > 0) return true;
  if (receipt.contractAddress) return true;
  if (extractTraceAddresses(trace).length > 0 && extractAddressCandidates(receipt).length > 0) return true;
  const destinationMatches = context?.destination && context.mothership && context.destination.toLowerCase() === context.mothership.toLowerCase();
  const selectorMatches = context?.inputSelector && context.launchSelectors?.has(context.inputSelector.toLowerCase());
  return Boolean(destinationMatches && selectorMatches && extractAddressCandidates(receipt).length > 0);
}
