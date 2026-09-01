export const SIMULATED_BUY_AMOUNT_WEI = 800000000000000n; // 0.0008 ETH
export const ROBINHOOD_CHAIN_ID = 4663;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CALLDATA = /^0x[0-9a-fA-F]+$/;
export const PONS_BUY_SELECTOR = "0x59a87bc1";
function requireAddress(name, value) {
    if (!ADDRESS.test(value))
        throw new Error(`Invalid ${name}: ${value}`);
    return value.toLowerCase();
}
function encodeUint256(value) {
    if (value < 0n || value >= 1n << 256n)
        throw new Error("uint256 value is out of range");
    return value.toString(16).padStart(64, "0");
}
function encodeAddress(value) {
    return requireAddress("recipient", value).slice(2).padStart(64, "0");
}
export function encodePonsBuyCalldata(amountInWei, amountOutMinimum, recipient) {
    if (amountInWei <= 0n)
        throw new Error("Input amount must be positive");
    if (amountOutMinimum < 0n)
        throw new Error("Minimum output cannot be negative");
    return `${PONS_BUY_SELECTOR}${encodeUint256(amountInWei)}${encodeUint256(amountOutMinimum)}${encodeAddress(recipient)}`;
}
export function calculateMinimumOutput(policy, quotedAmountOut, slippageBps) {
    if (policy === "zero")
        return 0n;
    if (quotedAmountOut === undefined || quotedAmountOut <= 0n)
        throw new Error("A positive quote is required for slippage policy");
    if (slippageBps < 0n || slippageBps >= 10000n)
        throw new Error("Slippage must be between 0 and 9999 basis points");
    return (quotedAmountOut * (10000n - slippageBps)) / 10000n;
}
export function buildPonsBuyTransaction(route, now = Math.floor(Date.now() / 1000)) {
    const poolAddress = requireAddress("Pons pool", route.poolAddress);
    const recipient = requireAddress("recipient", route.recipient);
    const data = encodePonsBuyCalldata(route.amountInWei, route.amountOutMinimum, recipient);
    return buildUnsignedBuyTransaction({
        ...route,
        outputToken: route.tokenAddress,
        minAmountOut: route.amountOutMinimum,
        to: poolAddress,
        data,
        valueWei: route.amountInWei,
        recipient,
    }, now);
}
export function buildUnsignedBuyTransaction(route, now = Math.floor(Date.now() / 1000)) {
    const outputToken = requireAddress("output token", route.outputToken);
    requireAddress("input token", route.inputToken);
    requireAddress("recipient", route.recipient);
    const to = requireAddress("route entry contract", route.to);
    if (route.chainId !== ROBINHOOD_CHAIN_ID)
        throw new Error(`Unsupported chain ID: ${route.chainId}`);
    if (route.amountInWei <= 0n)
        throw new Error("Input amount must be positive");
    if (route.minAmountOut < 0n)
        throw new Error("Minimum output cannot be negative");
    if (route.valueWei !== route.amountInWei)
        throw new Error("Native input value must equal input amount");
    if (route.deadline <= now)
        throw new Error("Route deadline has expired");
    if (!CALLDATA.test(route.data) || route.data.length < 10)
        throw new Error("Route calldata is missing or invalid");
    if (route.gasLimit <= 0n)
        throw new Error("Gas limit must be positive");
    if (route.maxFeePerGas <= 0n || route.maxPriorityFeePerGas <= 0n)
        throw new Error("EIP-1559 fee fields must be positive");
    if (route.maxPriorityFeePerGas > route.maxFeePerGas)
        throw new Error("Priority fee cannot exceed max fee");
    if (!Number.isSafeInteger(route.nonce) || route.nonce < 0)
        throw new Error("Nonce must be a non-negative safe integer");
    if (route.type === "legacy")
        throw new Error("Legacy fee transactions are not supported by this builder yet");
    return {
        chainId: ROBINHOOD_CHAIN_ID,
        nonce: route.nonce,
        to,
        data: route.data,
        value: route.valueWei,
        gasLimit: route.gasLimit,
        maxFeePerGas: route.maxFeePerGas,
        maxPriorityFeePerGas: route.maxPriorityFeePerGas,
        type: "eip1559",
    };
}
export function simulateFastBuy(token, fixtures, retryDelaysMs = [0, 25, 75]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token))
        throw new Error(`Invalid token address: ${token}`);
    if (fixtures.length === 0)
        throw new Error("At least one simulated attempt is required");
    const attempts = [];
    for (let i = 0; i < fixtures.length; i++) {
        const fixture = fixtures[i];
        const elapsedMs = retryDelaysMs[i] ?? retryDelaysMs.at(-1) ?? 0;
        const slippageOk = fixture.expectedTokenOut === undefined || fixture.minTokenOut === undefined || fixture.expectedTokenOut >= fixture.minTokenOut;
        const accepted = fixture.accepted && slippageOk;
        attempts.push({
            attempt: i + 1,
            elapsedMs,
            amountWei: SIMULATED_BUY_AMOUNT_WEI,
            token: token.toLowerCase(),
            accepted,
            reason: accepted ? "SIMULATED_ACCEPTED" : (fixture.reason ?? (slippageOk ? "SIMULATED_REJECTED" : "MIN_OUT_NOT_MET")),
        });
        if (accepted) {
            return {
                mode: "DRY_RUN",
                token: token.toLowerCase(),
                amountWei: SIMULATED_BUY_AMOUNT_WEI,
                success: true,
                attempts,
                firstActionMs: attempts[0].elapsedMs,
                completionMs: elapsedMs,
            };
        }
    }
    return {
        mode: "DRY_RUN",
        token: token.toLowerCase(),
        amountWei: SIMULATED_BUY_AMOUNT_WEI,
        success: false,
        attempts,
        firstActionMs: attempts[0].elapsedMs,
        completionMs: attempts.at(-1)?.elapsedMs ?? 0,
    };
}
