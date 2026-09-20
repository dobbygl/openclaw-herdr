export interface HerdrPluginConfig {
  socketPath?: string;
  requestTimeoutMs: number;
  watchTimeoutMinutes: number;
  readLines: number;
}

export function readPluginConfig(raw: Record<string, unknown> | undefined): HerdrPluginConfig {
  const config = raw ?? {};
  const number = (key: string, fallback: number): number => {
    const value = config[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const socketPath = typeof config.socketPath === "string" && config.socketPath.trim() ? config.socketPath : undefined;
  return {
    ...(socketPath ? { socketPath } : {}),
    requestTimeoutMs: number("requestTimeoutMs", 5_000),
    watchTimeoutMinutes: number("watchTimeoutMinutes", 720),
    readLines: number("readLines", 40),
  };
}
