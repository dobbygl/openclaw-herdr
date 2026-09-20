export interface HerdrPluginConfig {
  socketPath?: string;
  requestTimeoutMs: number;
  watchTimeoutMinutes: number;
  readLines: number;
  /**
   * `openclaw` executable used to deliver watch results when the in-process
   * Gateway seam is not available. Resolved from PATH when unset.
   */
  openclawBin?: string;
  /** Budget for one watch-result delivery (`chat.send`), in-process or via the CLI. */
  deliveryTimeoutMs: number;
}

export function readPluginConfig(raw: Record<string, unknown> | undefined): HerdrPluginConfig {
  const config = raw ?? {};
  const number = (key: string, fallback: number): number => {
    const value = config[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const text = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const socketPath = text("socketPath");
  const openclawBin = text("openclawBin");
  return {
    ...(socketPath ? { socketPath } : {}),
    requestTimeoutMs: number("requestTimeoutMs", 5_000),
    watchTimeoutMinutes: number("watchTimeoutMinutes", 720),
    readLines: number("readLines", 40),
    ...(openclawBin ? { openclawBin } : {}),
    deliveryTimeoutMs: number("deliveryTimeoutMs", 60_000),
  };
}
