export const SIMULATED_BUY_AMOUNT_WEI = 800_000_000_000_000n; // 0.0008 ETH

export type BuyAttemptFixture = {
  accepted: boolean;
  reason?: string;
  expectedTokenOut?: bigint;
  minTokenOut?: bigint;
};

export type SimulatedBuyAttempt = {
  attempt: number;
  elapsedMs: number;
  amountWei: bigint;
  token: string;
  accepted: boolean;
  reason: string;
};

export type SimulatedBuyResult = {
  mode: "DRY_RUN";
  token: string;
  amountWei: bigint;
  success: boolean;
  attempts: SimulatedBuyAttempt[];
  firstActionMs: number;
  completionMs: number;
};

export function simulateFastBuy(
  token: string,
  fixtures: BuyAttemptFixture[],
  retryDelaysMs: number[] = [0, 25, 75],
): SimulatedBuyResult {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error(`Invalid token address: ${token}`);
  if (fixtures.length === 0) throw new Error("At least one simulated attempt is required");

  const attempts: SimulatedBuyAttempt[] = [];
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
