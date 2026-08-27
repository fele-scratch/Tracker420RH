import WebSocket from "ws";

const endpoint = process.env.RPC_WS_URL;
const targetWallet = process.env.TARGET_WALLET?.toLowerCase();
const method = process.env.PROBE_METHOD ?? "mined";
const durationMs = Number(process.env.PROBE_DURATION_MS ?? 60000);
const discoveryDelayMs = Number(process.env.DISCOVERY_DELAY_MS ?? 1000);
const reconnectDelayMs = Number(process.env.RECONNECT_DELAY_MS ?? 1000);

if (!endpoint) throw new Error("RPC_WS_URL is required");
if (!targetWallet || !/^0x[0-9a-f]{40}$/.test(targetWallet)) {
  throw new Error("TARGET_WALLET must be a 20-byte 0x-prefixed address");
}
if (!["mined", "pending"].includes(method)) {
  throw new Error("PROBE_METHOD must be mined or pending");
}
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error("PROBE_DURATION_MS must be a positive number");
}

const startedAt = Date.now();
let socket;
let reconnectTimer;
let discoveryTimer;
let finishTimer;
let nextRequestId = 1;
let activeSubscription;
let subscriptionAccepted = false;
let walletTransactionReceived = false;
let reconnectCount = 0;
let closed = false;

function log(event, details = {}) {
  console.log(JSON.stringify({
    event,
    observedAt: new Date().toISOString(),
    method,
    ...details,
  }));
}

function requestParams() {
  if (method === "mined") {
    return ["alchemy_minedTransactions", {
      addresses: [{ from: targetWallet }],
      includeRemoved: false,
      hashesOnly: false,
    }];
  }
  return ["alchemy_pendingTransactions", {
    fromAddress: [targetWallet],
    toAddress: [targetWallet],
  }];
}

function sendSubscription() {
  if (!socket || socket.readyState !== WebSocket.OPEN || activeSubscription) return;
  const id = nextRequestId++;
  log("SUBSCRIPTION_REQUEST_SENT", {
    requestId: id,
    params: requestParams(),
  });
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params: requestParams() }));
}

function extractTransaction(result) {
  return method === "mined" ? result?.transaction ?? result : result;
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    log("NON_JSON_MESSAGE");
    return;
  }

  if (typeof message.result === "string" && message.id !== undefined) {
    activeSubscription = message.result;
    subscriptionAccepted = true;
    log("SUBSCRIPTION_ACCEPTED", { requestId: message.id, subscription: activeSubscription });
  } else if (message.error) {
    log("SUBSCRIPTION_ERROR", {
      requestId: message.id,
      code: message.error.code,
      message: message.error.message,
      data: message.error.data,
    });
  }

  if (message.method !== "eth_subscription" || message.params?.result === undefined) return;

  const result = message.params.result;
  const transaction = extractTransaction(result) ?? {};
  const from = typeof transaction.from === "string" ? transaction.from.toLowerCase() : undefined;
  const to = typeof transaction.to === "string" ? transaction.to.toLowerCase() : undefined;
  const matchesTarget = from === targetWallet || to === targetWallet;
  const receivedAt = Date.now();

  log("TRANSACTION_NOTIFICATION_RECEIVED", {
    subscription: message.params.subscription,
    matchesTarget,
    actualWalletTransaction: matchesTarget,
    receivedAtEpochMs: receivedAt,
    transaction: {
      hash: transaction.hash,
      from: transaction.from,
      to: transaction.to,
      blockNumber: transaction.blockNumber,
      status: transaction.status,
      timestamp: transaction.timestamp ?? transaction.blockTimestamp,
    },
  });

  if (matchesTarget) {
    walletTransactionReceived = true;
    log("WALLET_TRANSACTION_CONFIRMED", {
      hash: transaction.hash,
      latencyMs: receivedAt - startedAt,
      providerTimestamp: transaction.timestamp ?? transaction.blockTimestamp,
    });
  }
}

function scheduleReconnect() {
  if (closed || Date.now() >= startedAt + durationMs || reconnectTimer) return;
  reconnectCount += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelayMs);
  log("RECONNECT_SCHEDULED", { reconnectCount, delayMs: reconnectDelayMs });
}

function connect() {
  if (closed) return;
  activeSubscription = undefined;
  log("CONNECTING");
  socket = new WebSocket(endpoint);
  socket.on("open", () => {
    log("WS_CONNECTED");
    // This models candidate discovery: no wallet subscription exists until this fires.
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined;
      log("CANDIDATE_WALLET_DISCOVERED", { wallet: targetWallet });
      sendSubscription();
    }, discoveryDelayMs);
  });
  socket.on("message", handleMessage);
  socket.on("error", (error) => log("WS_ERROR", { message: error.message }));
  socket.on("close", (code, reason) => {
    activeSubscription = undefined;
    log("WS_CLOSED", { code, reason: reason.toString() });
    scheduleReconnect();
  });
}

function finish() {
  if (closed) return;
  closed = true;
  clearTimeout(discoveryTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(finishTimer);
  if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "probe complete");
  log("SUMMARY", {
    durationMs: Date.now() - startedAt,
    subscriptionAccepted,
    actualWalletTransactionReceived: walletTransactionReceived,
    reconnectCount,
    conclusion: walletTransactionReceived ? "DELIVERY_OBSERVED" : "NO_DELIVERY_OBSERVED",
  });
  process.exitCode = walletTransactionReceived ? 0 : 3;
}

log("PROBE_STARTED", {
  targetWallet,
  durationMs,
  discoveryDelayMs,
  dynamicSequence: ["NO_WALLET_SUBSCRIPTION", "CANDIDATE_DISCOVERED", "WALLET_SUBSCRIPTION_CREATED"],
});
connect();
finishTimer = setTimeout(finish, durationMs);
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
