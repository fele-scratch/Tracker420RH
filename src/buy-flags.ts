export type BuySessionFlags = {
  prepare: boolean;
  execute: boolean;
};

export function resolveBuySessionFlags(env: Record<string, string | undefined>): BuySessionFlags {
  const buyPlanRaw = env.BUY_PLAN ?? env.BUY_ENABLED ?? "false";
  const buyExecuteRaw = env.BUY_EXECUTE ?? "false";

  const prepare = buyPlanRaw === "true" || buyPlanRaw === "1" || buyPlanRaw === "yes";
  const execute = buyExecuteRaw === "true" || buyExecuteRaw === "1" || buyExecuteRaw === "yes";

  return {
    prepare: prepare || execute,
    execute,
  };
}
