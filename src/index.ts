import "dotenv/config";
import WebSocket from "ws";
import { buildGmgnUnsignedBuy } from "./gmgn-buy.js";
import { extractAddressCandidates, extractPonsLaunchTokenCandidates, extractTraceAddresses, extractZeroAddressMints, hasLaunchEvidence, selector } from "./launch-analysis.js";

const HTTP = must("RPC_HTTP_URL");
const WS = must("RPC_WS_URL");
const MOTHERSHIP = address(process.env.MOTHERSHIP_ADDRESS ?? "0x6bed168687c1bca3466f1f3fb188c2dd058f4597");
const BUNDLE_TOPIC = process.env.BUNDLE_CREATED_TOPIC?.toLowerCase();
const CANDIDATE_TTL_MS = Number(process.env.CANDIDATE_TTL_MS ?? 900_000);
const BUY_ENABLED = process.env.BUY_ENABLED === "true";
const BUY_RECIPIENT = process.env.BUY_RECIPIENT ? address(process.env.BUY_RECIPIENT) : null;
const BUY_AMOUNT_WEI = parsePositiveBigInt(process.env.BUY_AMOUNT_WEI, 800_000_000_000_000n);
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const BUY_EXECUTION_MODE = process.env.BUY_EXECUTION_MODE ?? "gmgn_unsigned_tx";
const GMGN_SLIPPAGE_PERCENT = Number(process.env.GMGN_SLIPPAGE_PERCENT ?? "15");

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };
type Tx = { hash: string; from: string; to: string | null; input: string; blockNumber?: string; transactionIndex?: string };
type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string };
type Receipt = { status: string; contractAddress?: string | null; logs: Log[] };
type Candidate = { wallet: string; firstSeenBlock: bigint; expiresAt: number; sourceTx: string };

const candidates = new Map<string, Candidate>();
let refreshCandidateSubscriptions: (() => void) | null = null;

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parsePositiveBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return value.toLowerCase();
}

function log(message: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data }));
}

function safeEndpoint(endpoint: string): string {
  return endpoint.replace(/(\/v2\/)[^/?]+/, "$1***");
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as RpcResponse<T>;
  if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`RPC returned no result for ${method}`);
  return body.result;
}

async function getReceipt(hash: string): Promise<Receipt> {
  return rpc<Receipt>("eth_getTransactionReceipt", [hash]);
}

async function validToken(token: string, trustedLaunchToken = false): Promise<boolean> {
  const code = await rpc<string>("eth_getCode", [token, "latest"]);
  if (code === "0x" || code.length <= 4) return false;
  if (trustedLaunchToken) return true;
  // A generic token candidate must expose at least one standard ERC-20 metadata/supply call.
  const probes = ["0x06fdde03", "0x95d89b41", "0x18160ddd"];
  let successes = 0;
  for (const data of probes) {
    try {
      const result = await rpc<string>("eth_call", [{ to: token, data }, "latest"]);
      if (result && result !== "0x") successes++;
    } catch {}
  }
  return successes >= 1;
}

async function getTrace(hash: string): Promise<unknown | null> {
  for (const method of ["trace_transaction", "debug_traceTransaction"]) {
    try {
      return await rpc<unknown>(method, method === "trace_transaction" ? [hash] : [hash, {}]);
    } catch {}
  }
  return null;
}

async function prepareBuyPlan(tokenAddress: string, launchTx: Tx): Promise<Record<string, unknown>> {
  if (!BUY_RECIPIENT) throw new Error("BUY_RECIPIENT is required for BUY plan generation");
  if (BUY_EXECUTION_MODE !== "gmgn_unsigned_tx") throw new Error("gmgn_submit is not implemented; broadcasting remains disabled");
  if (!GMGN_API_KEY) throw new Error("GMGN_API_KEY is required for BUY plan generation");
  const plan = await buildGmgnUnsignedBuy({ apiKey: GMGN_API_KEY, tokenAddress, recipient: BUY_RECIPIENT, amountInWei: BUY_AMOUNT_WEI, slippagePercent: GMGN_SLIPPAGE_PERCENT });
  return { ...plan, launchTransaction: launchTx.hash, signed: false, broadcast: false };
}

function discoverCandidate(wallet: string, block: bigint, sourceTx: string): void {
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

async function inspectWalletTransaction(tx: Tx): Promise<void> {
  const wallet = tx.from.toLowerCase();
  const candidate = candidates.get(wallet);
  if (!candidate || candidate.expiresAt < Date.now()) {
    candidates.delete(wallet);
    return;
  }

  const receipt = await getReceipt(tx.hash);
  if (receipt.status !== "0x1") return;

  const trace = await getTrace(tx.hash);
  const zeroMintTokens = extractZeroAddressMints(receipt);
  const ponsEventTokens = extractPonsLaunchTokenCandidates(receipt);
  const receiptCandidates = extractAddressCandidates(receipt);
  const traceCandidates = extractTraceAddresses(trace as never);
  const tokenCandidates = [...new Set([...zeroMintTokens, ...ponsEventTokens, ...receiptCandidates, ...traceCandidates])];
  const method = selector(tx.input);
  const launchSelectors = new Set(["0x3c05c981", "0x70237117", "0x916d099c"]);
  if (!hasLaunchEvidence(receipt, trace as never, { destination: tx.to, inputSelector: method, mothership: MOTHERSHIP, launchSelectors })) return;

  const validTokens: string[] = [];
  for (const token of tokenCandidates) {
    if (await validToken(token, ponsEventTokens.includes(token) || zeroMintTokens.includes(token))) validTokens.push(token);
  }
  if (validTokens.length === 0) return;

  let buyPlan: Record<string, unknown> | undefined;
  if (BUY_RECIPIENT) {
    const tokenAddress = validTokens.find((token) => zeroMintTokens.includes(token) || ponsEventTokens.includes(token));
    if (!tokenAddress) {
      log("BUY_PLAN_UNAVAILABLE", { reason: "launch receipt did not expose a validated token", launchTx: tx.hash });
    } else {
      try {
        buyPlan = await prepareBuyPlan(tokenAddress, tx);
      } catch (error) {
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

async function handleMothershipTransaction(tx: Tx): Promise<void> {
  if (!BUNDLE_TOPIC || tx.to?.toLowerCase() !== MOTHERSHIP) return;
  if (!tx.blockNumber) return;
  const receipt = await getReceipt(tx.hash);
  const bundleLog = receipt.logs?.find((item) =>
    item.address.toLowerCase() === MOTHERSHIP && item.topics?.[0]?.toLowerCase() === BUNDLE_TOPIC,
  );
  if (!bundleLog) return;
  discoverCandidate(tx.from, BigInt(tx.blockNumber), tx.hash);
}

function connect(): void {
  const socket = new WebSocket(WS);
  let nextId = 1;
  let socketReady = false;
  let candidateMiningSubscriptionId: string | null = null;
  let candidateMiningRequestId: number | null = null;
  let mothershipMiningSubscriptionId: string | null = null;
  let mothershipMiningRequestId: number | null = null;

  const syncCandidateMiningSubscription = (): void => {
    if (!socketReady) return;
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
      const message = JSON.parse(raw.toString()) as {
        id?: number;
        result?: string | boolean;
        error?: { code: number; message: string };
        params?: { subscription: string; result: Tx | { removed: boolean; transaction: Tx } };
      };
      if (message.error) {
        log("WS_RPC_ERROR", { error: message.error });
        return;
      }
      if (message.id && typeof message.result === "string") {
        if (message.id === candidateMiningRequestId) candidateMiningSubscriptionId = message.result;
        if (message.id === mothershipMiningRequestId) mothershipMiningSubscriptionId = message.result;
        log("WS_SUBSCRIPTION_ACCEPTED", {
          requestId: message.id,
          subscription: message.result,
          stream: message.id === candidateMiningRequestId ? "candidate-wallets" :
            message.id === mothershipMiningRequestId ? "mothership-to-filter" : "other",
        });
        return;
      }
      const result = message.params?.result;
      if (!result) return;
      if (message.params?.subscription === mothershipMiningSubscriptionId) {
        await handleMothershipTransaction(result as unknown as Tx);
      } else if ("transaction" in result) {
        const mined = result as { removed: boolean; transaction: Tx };
        if (!mined.removed) await inspectWalletTransaction(mined.transaction);
      }
    } catch (error) {
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
    log("WS_CLOSED_RECONNECTING");
    setTimeout(connect, 1_000);
  });
}

log("STARTING", {
  mothership: MOTHERSHIP,
  bundleTopic: BUNDLE_TOPIC ?? "disabled; set BUNDLE_CREATED_TOPIC to enable discovery",
  buyEnabled: BUY_ENABLED,
  mode: BUY_ENABLED ? "guarded execution placeholder" : "dry-run detection",
  candidateMonitoring: "Alchemy alchemy_minedTransactions address-filtered WebSocket",
  mothershipMonitoring: "Alchemy alchemy_minedTransactions to-filtered WebSocket",
});
connect();
