import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_GMGN_CHAIN = "robinhood";
export const ROBINHOOD_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type JsonObject = Record<string, unknown>;

export type GmgnBuyRequest = {
  apiKey: string;
  tokenAddress: string;
  recipient: string;
  amountInWei: bigint;
  slippagePercent: number;
  apiBaseUrl?: string;
};

export type GmgnUnsignedTransaction = {
  chainId: number;
  nonce?: number;
  to: string;
  data: string;
  value: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  type?: "eip1559" | "legacy";
};

export type GmgnBuyPlan = {
  mode: "gmgn_unsigned_tx";
  route: JsonObject;
  simulation: JsonObject;
  transaction: GmgnUnsignedTransaction;
};

function address(name: string, value: unknown): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GMGN response missing ${name}`);
  return value as JsonObject;
}

function responseData(value: unknown): unknown {
  const body = object(value, "body");
  if (body.code !== undefined && body.code !== 0 && body.code !== "0") {
    throw new Error(`GMGN error: ${String(body.msg ?? body.message ?? body.code)}`);
  }
  return body.data ?? body;
}

function first(objectValue: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) if (objectValue[key] !== undefined) return objectValue[key];
  return undefined;
}

function bigintField(value: unknown, name: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") throw new Error(`GMGN transaction missing ${name}`);
  return BigInt(value);
}

function numberField(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid GMGN ${name}`);
  return parsed;
}

function findTransaction(value: unknown): JsonObject {
  const candidate = object(value, "transaction");
  const nested = first(candidate, "transaction", "tx", "data");
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as JsonObject;
  return candidate;
}

function mapTransaction(raw: unknown, expectedRecipient: string): GmgnUnsignedTransaction {
  const tx = findTransaction(raw);
  const to = address("transaction.to", first(tx, "to", "to_address"));
  const data = first(tx, "data", "input", "input_data");
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data)) throw new Error("GMGN transaction missing calldata");
  const chainId = Number(first(tx, "chainId", "chain_id"));
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`GMGN returned unexpected chain ID: ${chainId}`);
  const value = bigintField(first(tx, "value", "valueWei", "value_wei"), "value");
  const gasLimitValue = first(tx, "gasLimit", "gas_limit");
  const nonceValue = first(tx, "nonce");
  const maxFeeValue = first(tx, "maxFeePerGas", "max_fee_per_gas");
  const priorityValue = first(tx, "maxPriorityFeePerGas", "max_priority_fee_per_gas");
  const gasPriceValue = first(tx, "gasPrice", "gas_price");
  if (nonceValue === undefined) throw new Error("GMGN transaction missing nonce");
  if (gasLimitValue === undefined) throw new Error("GMGN transaction missing gas limit");
  if (maxFeeValue === undefined && gasPriceValue === undefined) throw new Error("GMGN transaction missing fee fields");
  if (maxFeeValue !== undefined && priorityValue === undefined) throw new Error("GMGN transaction missing max priority fee");
  if (expectedRecipient.length !== 42) throw new Error("Invalid buyer recipient");
  return {
    chainId,
    nonce: numberField(nonceValue, "nonce"),
    to,
    data,
    value,
    gasLimit: bigintField(gasLimitValue, "gas limit"),
    ...(maxFeeValue !== undefined ? { maxFeePerGas: bigintField(maxFeeValue, "max fee"), maxPriorityFeePerGas: bigintField(priorityValue, "max priority fee"), type: "eip1559" as const } : { gasPrice: bigintField(gasPriceValue, "gas price"), type: "legacy" as const }),
  };
}

export async function buildGmgnUnsignedBuy(request: GmgnBuyRequest): Promise<GmgnBuyPlan> {
  const tokenAddress = address("output token", request.tokenAddress);
  const recipient = address("recipient", request.recipient);
  if (!request.apiKey) throw new Error("GMGN_API_KEY is required");
  if (request.amountInWei <= 0n) throw new Error("Buy amount must be positive");
  if (!Number.isFinite(request.slippagePercent) || request.slippagePercent < 0 || request.slippagePercent >= 100) throw new Error("Invalid GMGN slippage");
  const base = (request.apiBaseUrl ?? "https://gmgn.ai").replace(/\/$/, "");
  const headers = { "x-route-key": request.apiKey, accept: "application/json" };
  const routeUrl = new URL(`${base}/defi/router/v1/tx/available_routes_exact_in`);
  routeUrl.search = new URLSearchParams({
    token_in_chain: ROBINHOOD_GMGN_CHAIN,
    token_out_chain: ROBINHOOD_GMGN_CHAIN,
    token_in_address: ROBINHOOD_NATIVE_TOKEN,
    token_out_address: tokenAddress,
    in_amount: request.amountInWei.toString(),
  }).toString();
  const routeResponse = await fetch(routeUrl, { headers });
  if (!routeResponse.ok) throw new Error(`GMGN route HTTP ${routeResponse.status}`);
  const routeBody = responseData(await routeResponse.json());
  const routes = Array.isArray(routeBody) ? routeBody : (object(routeBody, "routes").routes ?? routeBody);
  const route = Array.isArray(routes) ? routes[0] : routes;
  const routeObject = object(route, "route");
  const simulationResponse = await fetch(`${base}/defi/router/v1/tx/simulate_route_exact_in`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ route: routeObject, slippage: request.slippagePercent, from_address: recipient }),
  });
  if (!simulationResponse.ok) throw new Error(`GMGN simulation HTTP ${simulationResponse.status}`);
  const simulation = object(responseData(await simulationResponse.json()), "simulation");
  const transaction = mapTransaction(simulation, recipient);
  if (transaction.value !== request.amountInWei) throw new Error("GMGN transaction value does not equal requested amount");
  return { mode: "gmgn_unsigned_tx", route: routeObject, simulation, transaction };
}
