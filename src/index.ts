import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { CREATE_BUNDLE_SELECTOR, isSuccessfulReceipt, isCreateBundleTransaction } from "./detection.js";
import { resolveBuySessionFlags } from "./buy-flags.js";
import { buildGmgnUnsignedBuy } from "./gmgn-buy.js";
import { decodeLaunchAndBuyArgs, extractAddressCandidates, extractPonsLaunchTokenCandidates, extractTraceAddresses, extractZeroAddressMints, hasLaunchEvidence, selector } from "./launch-analysis.js";

const HTTP = must("RPC_HTTP_URL");
const WS = must("RPC_WS_URL");
const MOTHERSHIP = address(process.env.MOTHERSHIP_ADDRESS ?? "0x6bed168687c1bca3466f1f3fb188c2dd058f4597");
const PONS_LAUNCH_ROUTER = address("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
const LAUNCH_SELECTOR = "0xf85f8e41";
const OKX_FUNDER = address("0x53091256EBD2D8aA37B45536A5FD864ca764f32f");
const MIN_EXEMPTIONS = positiveNumber(process.env.MIN_EXEMPTIONS, 25, "MIN_EXEMPTIONS");
const MAX_EXEMPTIONS = positiveNumber(process.env.MAX_EXEMPTIONS, 32, "MAX_EXEMPTIONS");
const MOTHERSHIP_DISCOVERY_ENABLED = process.env.MOTHERSHIP_DISCOVERY_ENABLED === "true";
const CANDIDATE_TTL_MS = positiveNumber(process.env.CANDIDATE_TTL_MS, 604_800_000, "CANDIDATE_TTL_MS");
const INITIAL_CANDIDATE_WALLETS = (process.env.INITIAL_CANDIDATE_WALLETS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => address(value));
const BUY_FLAGS = resolveBuySessionFlags(process.env);
const BUY_PLAN = BUY_FLAGS.prepare;
const BUY_EXECUTE = BUY_FLAGS.execute;
const BUY_ENABLED = BUY_FLAGS.prepare;
const BUY_RECIPIENT = process.env.BUY_RECIPIENT ? address(process.env.BUY_RECIPIENT) : null;
const BUY_AMOUNT_WEI = parseBuyAmount(process.env.BUY_AMOUNT_WEI, 800_000_000_000_000n);
const BUY_POST_LAUNCH_DELAY_MS = positiveNumber(process.env.BUY_POST_LAUNCH_DELAY_MS, 800, "BUY_POST_LAUNCH_DELAY_MS");
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const resolveGmgnPrivateKey = (): string | undefined => {
  const explicit = process.env.GMGN_PRIVATE_KEY?.trim();
  if (explicit) return explicit.replace(/\\n/g, "\n");
  const configuredFile = process.env.GMGN_PRIVATE_KEY_FILE?.trim();
  const filePath = configuredFile ? path.resolve(process.cwd(), configuredFile) : path.resolve(process.cwd(), "GMGN_PRIVATE_KEY_FILE");
  if (!fs.existsSync(filePath)) return undefined;
  const fileValue = fs.readFileSync(filePath, "utf8").trim();
  return fileValue ? fileValue.replace(/\\n/g, "\n") : undefined;
};
const GMGN_PRIVATE_KEY = resolveGmgnPrivateKey();
const BUY_EXECUTION_MODE = process.env.BUY_EXECUTION_MODE ?? "gmgn_agent_swap";
const GMGN_SLIPPAGE_PERCENT = positiveNumber(process.env.GMGN_SLIPPAGE_PERCENT, 15, "GMGN_SLIPPAGE_PERCENT");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };
type Tx = { hash: string; from: string; to: string | null; input: string; blockNumber?: string; transactionIndex?: string };
type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string };
type Receipt = { status: string; contractAddress?: string | null; logs: Log[] };
type Candidate = { wallet: string; firstSeenBlock: bigint; expiresAt: number; sourceTx: string };

const candidates = new Map<string, Candidate>();
const funderChecks = new Map<string, Promise<boolean>>();
let refreshCandidateSubscriptions: (() => void) | null = null;
let activeSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

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

function parseBuyAmount(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error(`Invalid BUY_AMOUNT_WEI: ${value}`);
  if (!value.includes(".")) return parsePositiveBigInt(value, fallback);
  const [whole, fraction] = value.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (wei <= 0n) throw new Error(`Invalid positive BUY_AMOUNT_WEI: ${value}`);
  return wei;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid positive number for ${name}: ${value}`);
  return parsed;
}

function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return value.toLowerCase();
}

function log(message: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data }));
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

async function notifyLaunch(tokenCA: string, arg5: string, launchTx: string): Promise<void> {
  try {
    await sendTelegramMessage(`LAUNCH_DETECTED\nCA: <code>${html(tokenCA)}</code>\narg5: ${html(arg5)}\nlaunchTx: ${html(launchTx)}`);
  } catch (error) {
    log("TELEGRAM_NOTIFY_ERROR", { event: "launch", error: String(error) });
  }
}

async function notifyBuySuccess(tokenCA: string, response: unknown): Promise<void> {
  if (!BUY_EXECUTE || !response || typeof response !== "object") return;
  const result = response as Record<string, unknown>;
  const status = String(result.status ?? result.state ?? "").toLowerCase();
  if (!["accepted", "submitted", "success", "succeeded", "pending"].includes(status)) return;
  const hash = result.tx_hash ?? result.transaction_hash ?? result.hash ?? result.order_id;
  if (hash === undefined) return;
  try {
    await sendTelegramMessage(`buy succeeded\nCA: <code>${html(tokenCA)}</code>\norder/tx: <code>${html(String(hash))}</code>`);
  } catch (error) {
    log("TELEGRAM_NOTIFY_ERROR", { event: "buy-success", error: String(error) });
  }
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

async function wasFundedByOkx(recipient: string): Promise<boolean> {
  const key = recipient.toLowerCase();
  const cached = funderChecks.get(key);
  if (cached) return cached;
  const check = (async () => {
    try {
      const result = await rpc<{ transfers?: Array<{ from?: string; to?: string; value?: number; asset?: string }> }>("alchemy_getAssetTransfers", [{
        fromBlock: "0x0", toBlock: "latest", toAddress: key, category: ["external"], order: "asc", maxCount: "0x20",
      }]);
      const firstFunding = (result.transfers ?? []).find((transfer) =>
        transfer.to?.toLowerCase() === key && transfer.from &&
        transfer.from.toLowerCase() !== "0x0000000000000000000000000000000000000000" &&
        (transfer.asset === undefined || transfer.asset === "ETH") && (transfer.value ?? 0) > 0,
      );
      return firstFunding?.from?.toLowerCase() === OKX_FUNDER;
    } catch (error) {
      log("FUNDER_CHECK_ERROR", { recipient: key, error: String(error) });
      return false;
    }
  })();
  funderChecks.set(key, check);
  return check;
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

function waitForBuyDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function prepareBuyPlan(tokenAddress: string, launchTx: Tx): Promise<Record<string, unknown>> {
  if (!BUY_RECIPIENT) throw new Error("BUY_RECIPIENT is required for BUY plan generation");
  if (BUY_EXECUTION_MODE !== "gmgn_agent_swap") throw new Error("Only gmgn_agent_swap is supported with the Agent API");
  if (!GMGN_API_KEY) throw new Error("GMGN_API_KEY is required for BUY plan generation");
  if (!GMGN_PRIVATE_KEY) throw new Error("GMGN_PRIVATE_KEY is required for Agent API trading");
  if (BUY_POST_LAUNCH_DELAY_MS > 0) {
    log("BUY_DELAY_WAITING", { delayMs: BUY_POST_LAUNCH_DELAY_MS, tokenAddress, launchTx: launchTx.hash });
    await waitForBuyDelay(BUY_POST_LAUNCH_DELAY_MS);
  }
  const plan = await buildGmgnUnsignedBuy({ apiKey: GMGN_API_KEY, privateKeyPem: GMGN_PRIVATE_KEY, tokenAddress, recipient: BUY_RECIPIENT, amountInWei: BUY_AMOUNT_WEI, slippagePercent: GMGN_SLIPPAGE_PERCENT });
  await notifyBuySuccess(tokenAddress, plan.response);
  return { ...plan, launchTransaction: launchTx.hash, signed: true, execute: BUY_EXECUTE, broadcast: BUY_EXECUTE, dryRun: !BUY_EXECUTE };
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

for (const wallet of INITIAL_CANDIDATE_WALLETS) {
  discoverCandidate(wallet, 0n, "configured-startup-seed");
}

function pruneExpiredCandidates(): number {
  const now = Date.now();
  let removed = 0;
  for (const [wallet, candidate] of candidates) {
    if (candidate.expiresAt <= now) {
      candidates.delete(wallet);
      removed++;
    }
  }
  if (removed > 0) log("CANDIDATES_EXPIRED", { removed, remaining: candidates.size });
  return removed;
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
  const launchSelectors = new Set(["0x3c05c981", "0x70237117", "0x916d099c", "0xf85f8e41"]);
  if (!hasLaunchEvidence(receipt, trace as never, { destination: tx.to, inputSelector: method, mothership: MOTHERSHIP, launchSelectors })) return;

  const validTokens: string[] = [];
  for (const token of tokenCandidates) {
    if (await validToken(token, ponsEventTokens.includes(token) || zeroMintTokens.includes(token))) validTokens.push(token);
  }
  if (validTokens.length === 0) return;
  const tokenCA = validTokens.find((token) => zeroMintTokens.includes(token) || ponsEventTokens.includes(token));

  let buyPlan: Record<string, unknown> | undefined;
  if (BUY_PLAN && BUY_RECIPIENT) {
    if (!tokenCA) {
      log("BUY_PLAN_UNAVAILABLE", { reason: "launch receipt did not expose a validated token", launchTx: tx.hash });
    } else {
      try {
        buyPlan = await prepareBuyPlan(tokenCA, tx);
      } catch (error) {
        log("BUY_PLAN_UNAVAILABLE", { reason: String(error), launchTx: tx.hash, tokenAddress: tokenCA });
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
    buyEnabled: BUY_PLAN,
    buyPlan,
    action: BUY_EXECUTE ? "EXECUTION_ENABLED" : "DRY_RUN_ONLY",
  });
  if (tokenCA) await notifyLaunch(tokenCA, wallet, tx.hash);

  // Deliberately no trading call here. The execution adapter must be reviewed and configured separately.
  candidates.delete(wallet);
  refreshCandidateSubscriptions?.();
}

async function handleMothershipTransaction(tx: Tx): Promise<void> {
  if (!isCreateBundleTransaction(tx, MOTHERSHIP) || !tx.blockNumber) return;
  const receipt = await getReceipt(tx.hash);
  if (!isSuccessfulReceipt(receipt)) return;
  discoverCandidate(tx.from, BigInt(tx.blockNumber), tx.hash);
}

async function handlePonsLaunchTransaction(tx: Tx): Promise<void> {
  if (tx.to?.toLowerCase() !== PONS_LAUNCH_ROUTER || selector(tx.input) !== LAUNCH_SELECTOR) return;
  const decoded = decodeLaunchAndBuyArgs(tx.input, MIN_EXEMPTIONS, MAX_EXEMPTIONS);
  if (!decoded || !(await wasFundedByOkx(decoded.recipient))) return;
  const receipt = await getReceipt(tx.hash);
  if (!isSuccessfulReceipt(receipt)) return;
  const zeroMintTokens = extractZeroAddressMints(receipt);
  const tokenAddress = zeroMintTokens[0];
  if (!tokenAddress) return;
  let buyPlan: Record<string, unknown> | undefined;
  if (BUY_PLAN && BUY_RECIPIENT) {
    try {
      buyPlan = await prepareBuyPlan(tokenAddress, tx);
    } catch (error) {
      log("BUY_PLAN_UNAVAILABLE", { reason: String(error), launchTx: tx.hash, tokenAddress });
    }
  }
  log("LAUNCH_DETECTED", {
    launchTx: tx.hash,
    router: PONS_LAUNCH_ROUTER,
    selector: LAUNCH_SELECTOR,
    arg5: decoded.recipient,
    exemptionCount: decoded.exemptions.length,
    funderCheck: true,
    tokenCA: tokenAddress,
    mintedTokens: zeroMintTokens,
    detectionEvidence: { zeroAddressMintTokens: zeroMintTokens },
    buyEnabled: BUY_PLAN,
    buyPlan,
    action: BUY_EXECUTE ? "EXECUTION_ENABLED" : "DRY_RUN_ONLY",
  });
  await notifyLaunch(tokenAddress, decoded.recipient, tx.hash);
}

function connect(): void {
  if (shuttingDown) return;
  const socket = new WebSocket(WS);
  activeSocket = socket;
  let nextId = 1;
  let socketReady = false;
  let candidateMiningSubscriptionId: string | null = null;
  let candidateMiningRequestId: number | null = null;
  let mothershipMiningSubscriptionId: string | null = null;
  let mothershipMiningRequestId: number | null = null;
  let ponsLaunchMiningSubscriptionId: string | null = null;
  let ponsLaunchMiningRequestId: number | null = null;

  const syncCandidateMiningSubscription = (): void => {
    if (!socketReady) return;
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
    ponsLaunchMiningRequestId = nextId++;
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: ponsLaunchMiningRequestId,
      method: "eth_subscribe",
      params: ["alchemy_minedTransactions", {
        addresses: [{ to: PONS_LAUNCH_ROUTER }],
        includeRemoved: false,
        hashesOnly: false,
      }],
    }));
    if (MOTHERSHIP_DISCOVERY_ENABLED) {
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
    }
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
        if (message.id === ponsLaunchMiningRequestId) ponsLaunchMiningSubscriptionId = message.result;
        log("WS_SUBSCRIPTION_ACCEPTED", {
          requestId: message.id,
          subscription: message.result,
          stream: message.id === candidateMiningRequestId ? "candidate-wallets" :
            message.id === mothershipMiningRequestId ? "mothership-to-filter" :
              message.id === ponsLaunchMiningRequestId ? "pons-launch-router" : "other",
        });
        return;
      }
      const result = message.params?.result;
      if (!result) return;
      if (message.params?.subscription === ponsLaunchMiningSubscriptionId) {
        const mined = result as { removed: boolean; transaction: Tx };
        if (!mined.removed) await handlePonsLaunchTransaction(mined.transaction);
      } else if (message.params?.subscription === mothershipMiningSubscriptionId) {
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
    ponsLaunchMiningSubscriptionId = null;
    ponsLaunchMiningRequestId = null;
    if (activeSocket === socket) activeSocket = null;
    if (shuttingDown) {
      log("WS_CLOSED");
      return;
    }
    log("WS_CLOSED_RECONNECTING");
    if (reconnectTimer === null) reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  });
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
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
  if (pruneExpiredCandidates() > 0) refreshCandidateSubscriptions?.();
}, Math.min(CANDIDATE_TTL_MS, 60_000));
candidateCleanupTimer.unref();

log("STARTING", {
  mothership: MOTHERSHIP,
  ponsLaunchRouter: PONS_LAUNCH_ROUTER,
  ponsLaunchSelector: LAUNCH_SELECTOR,
  candidateTrigger: `createBundle(${CREATE_BUNDLE_SELECTOR}) sent to mothership`,
  buyEnabled: BUY_ENABLED,
  mode: BUY_ENABLED ? "live execution" : "dry-run detection",
  candidateMonitoring: "Alchemy alchemy_minedTransactions address-filtered WebSocket",
  mothershipMonitoring: MOTHERSHIP_DISCOVERY_ENABLED ? "Alchemy alchemy_minedTransactions to-filtered WebSocket" : "disabled",
  ponsLaunchMonitoring: "Alchemy alchemy_minedTransactions to-filtered WebSocket with calldata prefilter",
});
connect();
