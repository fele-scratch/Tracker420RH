import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { CREATE_BUNDLE_SELECTOR, isSuccessfulReceipt, isCreateBundleTransaction } from "./detection.js";
import { resolveBuySessionFlags } from "./buy-flags.js";
import { buildGmgnUnsignedBuy } from "./gmgn-buy.js";
import { firstNonBlockedToken, isActiveCandidate, isFirstFundedByOkx, isFundAmountInRange, weiToEth } from "./candidate-analysis.js";
import { decodeLaunchAndBuyArgs, extractZeroAddressMints, selector } from "./launch-analysis.js";

const HTTP = must("RPC_HTTP_URL");
const WS = must("RPC_WS_URL");
const MOTHERSHIP = address(process.env.MOTHERSHIP_ADDRESS ?? "0x6bed168687c1bca3466f1f3fb188c2dd058f4597");
const PONS_LAUNCH_ROUTER = address("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
const LAUNCH_SELECTOR = "0xf85f8e41";
const OKX_FUNDER = address(process.env.OKX_FUNDER ?? "0x53091256EBD2D8aA37B45536A5FD864ca764f32f");
const MIN_FUND_ETH = positiveNumber(process.env.MIN_FUND_ETH, 0.56, "MIN_FUND_ETH");
const MAX_FUND_ETH = positiveNumber(process.env.MAX_FUND_ETH, 3.6, "MAX_FUND_ETH");
const FUND_ALERT_MIN_ETH = positiveNumber(process.env.FUND_ALERT_MIN_ETH, 0.6, "FUND_ALERT_MIN_ETH");
const FUND_ALERT_MAX_ETH = positiveNumber(process.env.FUND_ALERT_MAX_ETH, 1.1, "FUND_ALERT_MAX_ETH");
const MOTHERSHIP_DISCOVERY_ENABLED = process.env.MOTHERSHIP_DISCOVERY_ENABLED === "true";
const CANDIDATE_TTL_MS = positiveNumber(process.env.CANDIDATE_TTL_MS, 172_800_000, "CANDIDATE_TTL_MS");
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
const FUND_ALERT_BOT_TOKEN = process.env.FUND_ALERT_BOT_TOKEN;
const FUND_ALERT_CHAT_ID = process.env.FUND_ALERT_CHAT_ID;
const BASE_TOKEN_BLOCKLIST = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
]);

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };
type Tx = { hash: string; from: string; to: string | null; input: string; value?: string; blockNumber?: string; transactionIndex?: string };
type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex: string };
type Receipt = { status: string; contractAddress?: string | null; logs: Log[] };
type Candidate = { wallet: string; amountEth?: number; firstSeenAt: number; firstSeenBlock: bigint; expiresAt: number; sourceTx: string };

const candidates = new Map<string, Candidate>();
const funderChecks = new Map<string, Promise<boolean>>();
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

async function sendTelegramMessage(message: string, botToken = TELEGRAM_BOT_TOKEN, chatId = TELEGRAM_CHAT_ID): Promise<void> {
  if (!botToken || !chatId) return;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
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
  if (["failed", "failure", "rejected", "error"].includes(status)) {
    const reason = result.reason ?? result.msg ?? result.message ?? status;
    log("BUY_FAILED", { tokenCA, reason });
    try {
      await sendTelegramMessage(`buy failed\nCA: <code>${html(tokenCA)}</code>\nerror: ${html(String(reason))}`);
    } catch (error) {
      log("TELEGRAM_NOTIFY_ERROR", { event: "buy-failure", error: String(error) });
    }
    return;
  }
  if (!["accepted", "submitted", "success", "succeeded", "pending"].includes(status)) return;
  const hash = result.tx_hash ?? result.transaction_hash ?? result.hash ?? result.order_id;
  if (hash === undefined) return;
  try {
    await sendTelegramMessage(`buy succeeded\nCA: <code>${html(tokenCA)}</code>\norder/tx: <code>${html(String(hash))}</code>`);
  } catch (error) {
    log("TELEGRAM_NOTIFY_ERROR", { event: "buy-success", error: String(error) });
  }
}

async function notifyBuyFailure(tokenCA: string, launchTx: string, error: unknown): Promise<void> {
  if (!BUY_EXECUTE) return;
  try {
    await sendTelegramMessage(`buy failed\nCA: <code>${html(tokenCA)}</code>\nlaunchTx: <code>${html(launchTx)}</code>\nerror: ${html(String(error))}`);
  } catch (notificationError) {
    log("TELEGRAM_NOTIFY_ERROR", { event: "buy-failure", error: String(notificationError) });
  }
}

async function notifyFundAlert(wallet: string, amountEth: number, fundTx: string): Promise<void> {
  if (amountEth < FUND_ALERT_MIN_ETH || amountEth > FUND_ALERT_MAX_ETH) return;
  try {
    await sendTelegramMessage(`CANDIDATE_FUNDED\nwallet: <code>${html(wallet)}</code>\namount: ${amountEth} ETH\nfundTx: <code>${html(fundTx)}</code>`, FUND_ALERT_BOT_TOKEN, FUND_ALERT_CHAT_ID);
  } catch (error) {
    log("TELEGRAM_NOTIFY_ERROR", { event: "candidate-funded", error: String(error) });
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

async function wasFundedByOkx(recipient: string, fundingTxHash: string): Promise<boolean> {
  const key = recipient.toLowerCase();
  const cacheKey = `${key}:${fundingTxHash.toLowerCase()}`;
  const cached = funderChecks.get(cacheKey);
  if (cached) return cached;
  const check = (async () => {
    try {
      const inbound = await rpc<{ transfers?: Array<{ from?: string; to?: string; value?: number; asset?: string; hash?: string }> }>("alchemy_getAssetTransfers", [{
        fromBlock: "0x0", toBlock: "latest", toAddress: key, category: ["external"], order: "asc", maxCount: "0x20",
      }]);
      if (!isFirstFundedByOkx(inbound.transfers ?? [], key, OKX_FUNDER, fundingTxHash)) return false;
      return (await rpc<string>("eth_getTransactionCount", [key, "latest"])) === "0x0";
    } catch (error) {
      log("FUNDER_CHECK_ERROR", { recipient: key, error: String(error) });
      return false;
    }
  })();
  funderChecks.set(cacheKey, check);
  return check;
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

function discoverCandidate(wallet: string, block: bigint, sourceTx: string, amountEth?: number): void {
  const key = wallet.toLowerCase();
  const firstSeenAt = Date.now();
  candidates.set(key, {
    wallet: key,
    amountEth,
    firstSeenAt,
    firstSeenBlock: block,
    expiresAt: Date.now() + CANDIDATE_TTL_MS,
    sourceTx,
  });
  log("CANDIDATE_WALLET", { wallet: key, firstSeenBlock: block.toString(), sourceTx });
}

async function handleFunderTransaction(tx: Tx): Promise<void> {
  if (tx.from.toLowerCase() !== OKX_FUNDER || !tx.to || tx.value === undefined) return;
  const recipient = tx.to.toLowerCase();
  const valueWei = BigInt(tx.value);
  const amountEth = weiToEth(valueWei);
  const passAmount = isFundAmountInRange(valueWei, MIN_FUND_ETH, MAX_FUND_ETH);
  if (!passAmount) {
    log("FUNDER_TX", {
      to: recipient,
      valueEth: amountEth,
      passAmount: false,
      passFirstFunding: false,
      reason: "amount-out-of-range",
    });
    return;
  }
  const passFirstFunding = await wasFundedByOkx(recipient, tx.hash);
  const reason = !passAmount ? "amount-out-of-range" : !passFirstFunding ? "not-first-funding" : "accepted";
  log("FUNDER_TX", { to: recipient, valueEth: amountEth, passAmount, passFirstFunding, reason });
  if (!passAmount || !passFirstFunding) return;
  discoverCandidate(recipient, tx.blockNumber ? BigInt(tx.blockNumber) : 0n, tx.hash, amountEth);
  const candidate = candidates.get(recipient);
  log("CANDIDATE_FUNDED", { wallet: recipient, amountEth, firstSeenAt: candidate?.firstSeenAt, expiresAt: candidate?.expiresAt, fundTx: tx.hash });
  await notifyFundAlert(recipient, amountEth, tx.hash);
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

async function handleMothershipTransaction(tx: Tx): Promise<void> {
  if (!isCreateBundleTransaction(tx, MOTHERSHIP) || !tx.blockNumber) return;
  const receipt = await getReceipt(tx.hash);
  if (!isSuccessfulReceipt(receipt)) return;
  discoverCandidate(tx.from, BigInt(tx.blockNumber), tx.hash);
}

async function handlePonsLaunchTransaction(tx: Tx): Promise<void> {
  if (tx.to?.toLowerCase() !== PONS_LAUNCH_ROUTER || selector(tx.input) !== LAUNCH_SELECTOR) return;
  log("PONS_TX_RECEIVED", { launchTx: tx.hash });
  const decoded = decodeLaunchAndBuyArgs(tx.input);
  if (!decoded) return;
  const candidate = candidates.get(decoded.recipient);
  if (!isActiveCandidate(candidates, decoded.recipient)) {
    candidates.delete(decoded.recipient);
    return;
  }
  if (!candidate) return;
  const receipt = await getReceipt(tx.hash);
  if (!isSuccessfulReceipt(receipt)) return;
  const zeroMintTokens = extractZeroAddressMints(receipt);
  const tokenAddress = firstNonBlockedToken(zeroMintTokens, BASE_TOKEN_BLOCKLIST);
  if (!tokenAddress) return;
  let buyPlan: Record<string, unknown> | undefined;
  if (BUY_PLAN && BUY_RECIPIENT) {
    try {
      buyPlan = await prepareBuyPlan(tokenAddress, tx);
    } catch (error) {
      log("BUY_PLAN_UNAVAILABLE", { reason: String(error), launchTx: tx.hash, tokenAddress });
      await notifyBuyFailure(tokenAddress, tx.hash, error);
    }
  }
  log("LAUNCH_DETECTED", {
    launchTx: tx.hash,
    selector: LAUNCH_SELECTOR,
    arg5: decoded.recipient,
    exemptionCount: decoded.exemptions.length,
    candidateFundTx: candidate.sourceTx,
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
  let mothershipMiningSubscriptionId: string | null = null;
  let mothershipMiningRequestId: number | null = null;
  let ponsLaunchMiningSubscriptionId: string | null = null;
  let ponsLaunchMiningRequestId: number | null = null;
  let funderMiningSubscriptionId: string | null = null;
  let funderMiningRequestId: number | null = null;

  socket.on("open", () => {
    socketReady = true;
    log("WS_CONNECTED", { endpoint: safeEndpoint(WS) });
    log("LAUNCH_GATE", { rule: "router+0xf85f8e41+inventory" });
    log("ROUTER_SUBSCRIBED", { to: PONS_LAUNCH_ROUTER, selector: LAUNCH_SELECTOR });
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
    log("FUNDER_SUBSCRIBED", { from: OKX_FUNDER });
    funderMiningRequestId = nextId++;
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: funderMiningRequestId,
      method: "eth_subscribe",
      params: ["alchemy_minedTransactions", {
        addresses: [{ from: OKX_FUNDER }],
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
        if (message.id === mothershipMiningRequestId) mothershipMiningSubscriptionId = message.result;
        if (message.id === ponsLaunchMiningRequestId) ponsLaunchMiningSubscriptionId = message.result;
        if (message.id === funderMiningRequestId) funderMiningSubscriptionId = message.result;
        log("WS_SUBSCRIPTION_ACCEPTED", {
          requestId: message.id,
          subscription: message.result,
          stream: message.id === mothershipMiningRequestId ? "mothership-to-filter" :
              message.id === ponsLaunchMiningRequestId ? "pons-launch-router" :
                message.id === funderMiningRequestId ? "okx-funder-from-filter" : "other",
        });
        return;
      }
      const result = message.params?.result;
      if (!result) return;
      if (message.params?.subscription === ponsLaunchMiningSubscriptionId) {
        const mined = result as { removed: boolean; transaction: Tx };
        if (!mined.removed) await handlePonsLaunchTransaction(mined.transaction);
      } else if (message.params?.subscription === funderMiningSubscriptionId) {
        const mined = result as { removed: boolean; transaction: Tx };
        if (!mined.removed) await handleFunderTransaction(mined.transaction);
      } else if (message.params?.subscription === mothershipMiningSubscriptionId) {
        await handleMothershipTransaction(result as unknown as Tx);
      }
    } catch (error) {
      log("WS_MESSAGE_ERROR", { error: String(error) });
    }
  });

  socket.on("error", (error) => log("WS_ERROR", { error: String(error) }));
  socket.on("close", () => {
    socketReady = false;
    mothershipMiningSubscriptionId = null;
    mothershipMiningRequestId = null;
    ponsLaunchMiningSubscriptionId = null;
    ponsLaunchMiningRequestId = null;
    funderMiningSubscriptionId = null;
    funderMiningRequestId = null;
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
  log("SHUTTING_DOWN", { signal, candidates: candidates.size });
  if (activeSocket) {
    activeSocket.close(1000, "shutdown");
    activeSocket = null;
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const candidateCleanupTimer = setInterval(() => {
  pruneExpiredCandidates();
}, Math.min(CANDIDATE_TTL_MS, 60_000));
candidateCleanupTimer.unref();

log("STARTING", {
  mothership: MOTHERSHIP,
  ponsLaunchRouter: PONS_LAUNCH_ROUTER,
  ponsLaunchSelector: LAUNCH_SELECTOR,
  candidateTrigger: `createBundle(${CREATE_BUNDLE_SELECTOR}) sent to mothership`,
  buyEnabled: BUY_ENABLED,
  mode: BUY_ENABLED ? "live execution" : "dry-run detection",
  candidateMonitoring: "disabled; inventory is checked only at the Pons router",
  mothershipMonitoring: MOTHERSHIP_DISCOVERY_ENABLED ? "Alchemy alchemy_minedTransactions to-filtered WebSocket" : "disabled",
  ponsLaunchMonitoring: "Alchemy alchemy_minedTransactions to-filtered WebSocket with calldata prefilter",
});
connect();
