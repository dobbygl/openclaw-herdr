export interface HerdrPluginConfig {
  socketPath?: string;
  requestTimeoutMs: number;
  watchTimeoutMinutes: number;
  readLines: number;
  /** `herdr` executable. Resolved from PATH when unset. */
  herdrBin?: string;
  /** `ssh` executable used for remote machine transport. Resolved from PATH when unset. */
  sshBin?: string;
  /** Remote Herdr machine access. */
  remote: {
    /** Whether remote machines are discovered/reachable at all. Defaults to true. */
    enabled: boolean;
    /** Machine labels or profile ids allowed to receive prompts/key presses. Defaults to none. */
    allowSend: string[];
  };
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
  // Same contract as `text`, but returns the trimmed string: used for keys
  // matched against machine labels/executable names rather than passed
  // through verbatim.
  const trimmedText = (key: string): string | undefined => {
    const value = config[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const stringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed) result.push(trimmed);
    }
    return result;
  };

  const socketPath = text("socketPath");
  const herdrBin = trimmedText("herdrBin");
  const sshBin = trimmedText("sshBin");

  const remoteRaw = config["remote"];
  const remoteConfig =
    remoteRaw && typeof remoteRaw === "object" && !Array.isArray(remoteRaw)
      ? (remoteRaw as Record<string, unknown>)
      : undefined;
  const nestedEnabled = remoteConfig?.["enabled"];
  const topLevelEnabled = config["remoteEnabled"];
  const enabled =
    typeof nestedEnabled === "boolean" ? nestedEnabled : typeof topLevelEnabled === "boolean" ? topLevelEnabled : true;
  const nestedAllowSend = remoteConfig?.["allowSend"];
  const allowSendRaw = Array.isArray(nestedAllowSend) ? nestedAllowSend : config["remoteAllowSend"];

  return {
    ...(socketPath ? { socketPath } : {}),
    requestTimeoutMs: number("requestTimeoutMs", 5_000),
    watchTimeoutMinutes: number("watchTimeoutMinutes", 720),
    readLines: Math.min(400, Math.max(1, Math.trunc(number("readLines", 40)))),
    ...(herdrBin ? { herdrBin } : {}),
    ...(sshBin ? { sshBin } : {}),
    remote: {
      enabled,
      allowSend: stringArray(allowSendRaw),
    },
  };
}
