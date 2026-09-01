export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_TOPIC = "0x" + "0".repeat(64);
export const CREATE_BUNDLE_SELECTOR = "0x33b8ac0e";
export const KNOWN_LAUNCH_SELECTORS = new Set(["0x3c05c981", "0x70237117", "0x916d099c"]);
export function selector(input) {
    return input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x";
}
export function isCreateBundleTransaction(transaction, mothership) {
    return transaction.to?.toLowerCase() === mothership.toLowerCase() && selector(transaction.input) === CREATE_BUNDLE_SELECTOR;
}
export function extractMintedTokens(receipt) {
    const tokens = new Set();
    for (const item of receipt.logs ?? []) {
        if (item.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC)
            continue;
        if (item.topics?.[1]?.toLowerCase() !== ZERO_TOPIC)
            continue;
        if (/^0x[0-9a-fA-F]{40}$/.test(item.address))
            tokens.add(item.address.toLowerCase());
    }
    return [...tokens];
}
export function isSuccessfulReceipt(receipt) {
    return receipt.status === "0x1";
}
export function isCandidateLaunch(tx, receipt, mothership) {
    if (!isSuccessfulReceipt(receipt))
        return false;
    const minted = extractMintedTokens(receipt);
    const isKnownMothershipLaunch = tx.to?.toLowerCase() === mothership.toLowerCase() && KNOWN_LAUNCH_SELECTORS.has(selector(tx.input));
    return minted.length > 0 || isKnownMothershipLaunch;
}
export function candidateWalletFromBundle(transaction, mothership, receipt) {
    if (!isSuccessfulReceipt(receipt) || !isCreateBundleTransaction(transaction, mothership))
        return null;
    return transaction.from.toLowerCase();
}
