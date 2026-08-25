import WebSocket from "ws";

const url = process.env.RPC_WS_URL;
const wallet = process.env.PROBE_WALLET ?? "0xce8bc5a68aa4e063c4c87094286ae9939d0d903f";
if (!url) throw new Error("RPC_WS_URL is required");

const ws = new WebSocket(url);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 8000);
const timer = setTimeout(() => {
  console.error("TIMEOUT");
  ws.close();
  process.exit(2);
}, timeoutMs);

ws.on("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_subscribe",
    params: ["alchemy_minedTransactions", {
      addresses: [{ from: wallet }],
      includeRemoved: false,
      hashesOnly: false,
    }],
  }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  const mined = msg.params?.result?.transaction;
  console.log(JSON.stringify({
    id: msg.id,
    method: msg.method,
    result: typeof msg.result === "string" ? "SUBSCRIBED" : undefined,
    error: msg.error,
    subscription: msg.params?.subscription,
    minedTransaction: mined ? {
      hash: mined.hash,
      from: mined.from,
      to: mined.to,
      input: mined.input,
      blockNumber: mined.blockNumber,
      transactionIndex: mined.transactionIndex,
    } : undefined,
  }));
  if (msg.error) {
    clearTimeout(timer);
    ws.close();
    process.exit(1);
  }
  if (msg.method === "eth_subscription" && msg.params?.result) {
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (error) => {
  clearTimeout(timer);
  console.error(`WS_ERROR ${error.message}`);
  process.exit(1);
});
