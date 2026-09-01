import "dotenv/config";
import WebSocket from "ws";
import { CREATE_BUNDLE_SELECTOR, isSuccessfulReceipt, isCreateBundleTransaction } from "./detection.js";
import { buildGmgnUnsignedBuy } from "./gmgn-buy.js";
import { extractAddressCandidates, extractPonsLaunchTokenCandidates, extractTraceAddresses, extractZeroAddressMints, hasLaunchEvidence, selector } from "./launch-analysis.js";
const HTTP = must("RPC_HTTP_URL");
const WS = must("RPC_WS_URL");
const MOTHERSHIP = address(process.env.MOTHERSHIP_ADDRESS ?? "0x6bed168687c1bca3466f1f3fb188c2dd058f4597");
const CANDIDATE_TTL_MS = positiveNumber(process.env.CANDIDATE_TTL_MS, 604_800_000, "CANDIDATE_TTL_MS");
const INITIAL_CANDIDATE_WALLETS = (process.env.INITIAL_CANDIDATE_WALLETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => address(value));
const BUY_ENABLED = process.env.BUY_ENABLED === "true";
const BUY_RECIPIENT = process.env.BUY_RECIPIENT ? address(process.env.BUY_RECIPIENT) : null;
const BUY_AMOUNT_WEI = parseBuyAmount(process.env.BUY_AMOUNT_WEI, 800000000000000n);
const BUY_POST_LAUNCH_DELAY_MS = positiveNumber(process.env.BUY_POST_LAUNCH_DELAY_MS, 800, "BUY_POST_LAUNCH_DELAY_MS");
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const GMGN_PRIVATE_KEY = process.env.GMGN_PRIVATE_KEY?.replace(/\\n/g, "\n");
const BUY_EXECUTION_MODE = process.env.BUY_EXECUTION_MODE ?? "gmgn_agent_swap";
const GMGN_SLIPPAGE_PERCENT = positiveNumber(process.env.GMGN_SLIPPAGE_PERCENT, 15, "GMGN_SLIPPAGE_PERCENT");
const candidates = new Map();
let refreshCandidateSubscriptions = null;
let activeSocket = null;
let reconnectTimer = null;
let shuttingDown = false;
function must(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing ${name}`);
    return value;
}
function parsePositiveBigInt(value, fallback) {
    if (value === undefined || value === "")
        return fallback;
    const parsed = BigInt(value);
    if (parsed <= 0n)
        throw new Error(`Invalid positive integer: ${value}`);
    return parsed;
}
function parseBuyAmount(value, fallback) {
    if (value === undefined || value === "")
        return fallback;
    if (!/^\d+(?:\.\d{1,18})?$/.test(value))
        throw new Error(`Invalid BUY_AMOUNT_WEI: ${value}`);
    if (!value.includes("."))
        return parsePositiveBigInt(value, fallback);
    const [whole, fraction] = value.split(".");
    const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    if (wei <= 0n)
        throw new Error(`Invalid positive BUY_AMOUNT_WEI: ${value}`);
    return wei;
}
function positiveNumber(value, fallback, name) {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error(`Invalid positive number for ${name}: ${value}`);
    return parsed;
}
function address(value) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
        throw new Error(`Invalid address: ${value}`);
    return value.toLowerCase();
}
function log(message, data = {}) {
    console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data }));
}
function safeEndpoint(endpoint) {
    return endpoint.replace(/(\/v2\/)[^/?]+/, "$1***");
}
async function rpc(method, params) {
    const response = await fetch(HTTP, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    if (!response.ok)
        throw new Error(`RPC HTTP ${response.status}`);
    const body = (await response.json());
    if (body.error)
        throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined)
        throw new Error(`RPC returned no result for ${method}`);
    return body.result;
}
async function getReceipt(hash) {
    return rpc("eth_getTransactionReceipt", [hash]);
}
async function validToken(token, trustedLaunchToken = false) {
    const code = await rpc("eth_getCode", [token, "latest"]);
    if (code === "0x" || code.length <= 4)
        return false;
    if (trustedLaunchToken)
        return true;
    // A generic token candidate must expose at least one standard ERC-20 metadata/supply call.
    const probes = ["0x06fdde03", "0x95d89b41", "0x18160ddd"];
    let successes = 0;
    for (const data of probes) {
        try {
            const result = await rpc("eth_call", [{ to: token, data }, "latest"]);
            if (result && result !== "0x")
                successes++;
        }
        catch { }
    }
    return successes >= 1;
}
async function getTrace(hash) {
    for (const method of ["trace_transaction", "debug_traceTransaction"]) {
        try {
            return await rpc(method, method === "trace_transaction" ? [hash] : [hash, {}]);
        }
        catch { }
    }
    return null;
}
function waitForBuyDelay(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
async function prepareBuyPlan(tokenAddress, launchTx) {
    if (!BUY_RECIPIENT)
        throw new Error("BUY_RECIPIENT is required for BUY plan generation");
    if (BUY_EXECUTION_MODE !== "gmgn_agent_swap")
        throw new Error("Only gmgn_agent_swap is supported with the Agent API");
    if (!GMGN_API_KEY)
        throw new Error("GMGN_API_KEY is required for BUY plan generation");
    if (!GMGN_PRIVATE_KEY)
        throw new Error("GMGN_PRIVATE_KEY is required for Agent API trading");
    if (BUY_POST_LAUNCH_DELAY_MS > 0) {
        log("BUY_DELAY_WAITING", { delayMs: BUY_POST_LAUNCH_DELAY_MS, tokenAddress, launchTx: launchTx.hash });
        await waitForBuyDelay(BUY_POST_LAUNCH_DELAY_MS);
    }
    const plan = await buildGmgnUnsignedBuy({ apiKey: GMGN_API_KEY, privateKeyPem: GMGN_PRIVATE_KEY, tokenAddress, recipient: BUY_RECIPIENT, amountInWei: BUY_AMOUNT_WEI, slippagePercent: GMGN_SLIPPAGE_PERCENT });
    return { ...plan, launchTransaction: launchTx.hash, signed: true, broadcast: true };
}
function discoverCandidate(wallet, block, sourceTx) {
    const key = wallet.toLowerCase();
    candidates.set(key, {
        wallet: key,
        firstSeenBlock: block,
        expiresAt: Date.now() + CANDIDATE_TTL_MS,
        sourceTx,
    });
    log("CANDIDATE_WALLET", { wallet: key, firstSeenBlock: block.toString(), sourceTx });
    refreshCandidateSubscriptions?.();
}
for (const wallet of INITIAL_CANDIDATE_WALLETS) {
    discoverCandidate(wallet, 0n, "configured-startup-seed");
}
function pruneExpiredCandidates() {
    const now = Date.now();
    let removed = 0;
    for (const [wallet, candidate] of candidates) {
        if (candidate.expiresAt <= now) {
            candidates.delete(wallet);
            removed++;
        }
    }
    if (removed > 0)
        log("CANDIDATES_EXPIRED", { removed, remaining: candidates.size });
    return removed;
}
async function inspectWalletTransaction(tx) {
    const wallet = tx.from.toLowerCase();
    const candidate = candidates.get(wallet);
    if (!candidate || candidate.expiresAt < Date.now()) {
        candidates.delete(wallet);
        return;
    }
    const receipt = await getReceipt(tx.hash);
    if (receipt.status !== "0x1")
        return;
    const trace = await getTrace(tx.hash);
    const zeroMintTokens = extractZeroAddressMints(receipt);
    const ponsEventTokens = extractPonsLaunchTokenCandidates(receipt);
    const receiptCandidates = extractAddressCandidates(receipt);
    const traceCandidates = extractTraceAddresses(trace);
    const tokenCandidates = [...new Set([...zeroMintTokens, ...ponsEventTokens, ...receiptCandidates, ...traceCandidates])];
    const method = selector(tx.input);
    const launchSelectors = new Set(["0x3c05c981", "0x70237117", "0x916d099c"]);
    if (!hasLaunchEvidence(receipt, trace, { destination: tx.to, inputSelector: method, mothership: MOTHERSHIP, launchSelectors }))
        return;
    const validTokens = [];
    for (const token of tokenCandidates) {
        if (await validToken(token, ponsEventTokens.includes(token) || zeroMintTokens.includes(token)))
            validTokens.push(token);
    }
    if (validTokens.length === 0)
        return;
    let buyPlan;
    if (BUY_ENABLED && BUY_RECIPIENT) {
        const tokenAddress = validTokens.find((token) => zeroMintTokens.includes(token) || ponsEventTokens.includes(token));
        if (!tokenAddress) {
            log("BUY_PLAN_UNAVAILABLE", { reason: "launch receipt did not expose a validated token", launchTx: tx.hash });
        }
        else {
            try {
                buyPlan = await prepareBuyPlan(tokenAddress, tx);
            }
            catch (error) {
                log("BUY_PLAN_UNAVAILABLE", { reason: String(error), launchTx: tx.hash, tokenAddress });
            }
        }
    }
    log("LAUNCH_DETECTED", {
        wallet,
        sourcePreparationTx: candidate.sourceTx,
        launchTx: tx.hash,
        launchTo: tx.to,
        method,
        blockNumber: tx.blockNumber,
        transactionIndex: tx.transactionIndex,
        mintedTokens: validTokens,
        detectionEvidence: {
            zeroAddressMintTokens: zeroMintTokens,
            ponsEventTokenCandidates: ponsEventTokens,
            receiptAddressCandidates: receiptCandidates,
            traceAddressCandidates: traceCandidates,
            traceAvailable: trace !== null,
        },
        buyEnabled: BUY_ENABLED,
        buyPlan,
        action: BUY_ENABLED ? "EXECUTION_NOT_IMPLEMENTED" : "DRY_RUN_ONLY",
    });
    // Deliberately no trading call here. The execution adapter must be reviewed and configured separately.
    candidates.delete(wallet);
    refreshCandidateSubscriptions?.();
}
async function handleMothershipTransaction(tx) {
    if (!isCreateBundleTransaction(tx, MOTHERSHIP) || !tx.blockNumber)
        return;
    const receipt = await getReceipt(tx.hash);
    if (!isSuccessfulReceipt(receipt))
        return;
    discoverCandidate(tx.from, BigInt(tx.blockNumber), tx.hash);
}
function connect() {
    if (shuttingDown)
        return;
    const socket = new WebSocket(WS);
    activeSocket = socket;
    let nextId = 1;
    let socketReady = false;
    let candidateMiningSubscriptionId = null;
    let candidateMiningRequestId = null;
    let mothershipMiningSubscriptionId = null;
    let mothershipMiningRequestId = null;
    const syncCandidateMiningSubscription = () => {
        if (!socketReady)
            return;
        pruneExpiredCandidates();
        const wallets = [...candidates.keys()];
        if (wallets.length === 0) {
            if (candidateMiningSubscriptionId) {
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_unsubscribe", params: [candidateMiningSubscriptionId] }));
                candidateMiningSubscriptionId = null;
            }
            return;
        }
        if (wallets.length > 1000) {
            log("CANDIDATE_LIMIT", { count: wallets.length, limit: 1000 });
        }
        if (candidateMiningSubscriptionId) {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_unsubscribe", params: [candidateMiningSubscriptionId] }));
            candidateMiningSubscriptionId = null;
        }
        const addresses = wallets.slice(0, 1000).map((from) => ({ from }));
        candidateMiningRequestId = nextId++;
        socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: candidateMiningRequestId,
            method: "eth_subscribe",
            params: ["alchemy_minedTransactions", { addresses, includeRemoved: false, hashesOnly: false }],
        }));
        log("CANDIDATE_WALLET_SUBSCRIPTION_REFRESHED", { count: addresses.length });
    };
    socket.on("open", () => {
        socketReady = true;
        log("WS_CONNECTED", { endpoint: safeEndpoint(WS) });
        mothershipMiningRequestId = nextId++;
        socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: mothershipMiningRequestId,
            method: "eth_subscribe",
            params: ["alchemy_minedTransactions", {
                    addresses: [{ to: MOTHERSHIP }],
                    includeRemoved: false,
                    hashesOnly: false,
                }],
        }));
        refreshCandidateSubscriptions = syncCandidateMiningSubscription;
        syncCandidateMiningSubscription();
    });
    socket.on("message", async (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            if (message.error) {
                log("WS_RPC_ERROR", { error: message.error });
                return;
            }
            if (message.id && typeof message.result === "string") {
                if (message.id === candidateMiningRequestId)
                    candidateMiningSubscriptionId = message.result;
                if (message.id === mothershipMiningRequestId)
                    mothershipMiningSubscriptionId = message.result;
                log("WS_SUBSCRIPTION_ACCEPTED", {
                    requestId: message.id,
                    subscription: message.result,
                    stream: message.id === candidateMiningRequestId ? "candidate-wallets" :
                        message.id === mothershipMiningRequestId ? "mothership-to-filter" : "other",
                });
                return;
            }
            const result = message.params?.result;
            if (!result)
                return;
            if (message.params?.subscription === mothershipMiningSubscriptionId) {
                await handleMothershipTransaction(result);
            }
            else if ("transaction" in result) {
                const mined = result;
                if (!mined.removed)
                    await inspectWalletTransaction(mined.transaction);
            }
        }
        catch (error) {
            log("WS_MESSAGE_ERROR", { error: String(error) });
        }
    });
    socket.on("error", (error) => log("WS_ERROR", { error: String(error) }));
    socket.on("close", () => {
        socketReady = false;
        candidateMiningSubscriptionId = null;
        candidateMiningRequestId = null;
        mothershipMiningSubscriptionId = null;
        mothershipMiningRequestId = null;
        if (activeSocket === socket)
            activeSocket = null;
        if (shuttingDown) {
            log("WS_CLOSED");
            return;
        }
        log("WS_CLOSED_RECONNECTING");
        if (reconnectTimer === null)
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, 1_000);
    });
}
function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    if (reconnectTimer !== null)
        clearTimeout(reconnectTimer);
    reconnectTimer = null;
    refreshCandidateSubscriptions = null;
    log("SHUTTING_DOWN", { signal, candidates: candidates.size });
    if (activeSocket) {
        activeSocket.close(1000, "shutdown");
        activeSocket = null;
    }
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
const candidateCleanupTimer = setInterval(() => {
    if (pruneExpiredCandidates() > 0)
        refreshCandidateSubscriptions?.();
}, Math.min(CANDIDATE_TTL_MS, 60_000));
candidateCleanupTimer.unref();
log("STARTING", {
    mothership: MOTHERSHIP,
    candidateTrigger: `createBundle(${CREATE_BUNDLE_SELECTOR}) sent to mothership`,
    buyEnabled: BUY_ENABLED,
    mode: BUY_ENABLED ? "guarded execution placeholder" : "dry-run detection",
    candidateMonitoring: "Alchemy alchemy_minedTransactions address-filtered WebSocket",
    mothershipMonitoring: "Alchemy alchemy_minedTransactions to-filtered WebSocket",
});
connect();
