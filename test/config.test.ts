import { describe, expect, it } from "vitest";
import { readPluginConfig } from "../src/openclaw/config.js";

describe("readPluginConfig", () => {
  it("returns defaults for undefined config", () => {
    const config = readPluginConfig(undefined);
    expect(config).toEqual({
      requestTimeoutMs: 5_000,
      watchTimeoutMinutes: 720,
      readLines: 40,
      remote: { enabled: true, allowSend: [] },
    });
    expect(config).not.toHaveProperty("socketPath");
    expect(config).not.toHaveProperty("herdrBin");
    expect(config).not.toHaveProperty("sshBin");
  });

  it("returns defaults for an empty object", () => {
    const config = readPluginConfig({});
    expect(config).toEqual({
      requestTimeoutMs: 5_000,
      watchTimeoutMinutes: 720,
      readLines: 40,
      remote: { enabled: true, allowSend: [] },
    });
    expect(config).not.toHaveProperty("herdrBin");
    expect(config).not.toHaveProperty("sshBin");
  });

  it("parses herdrBin and sshBin, trimming surrounding whitespace", () => {
    const config = readPluginConfig({ herdrBin: "  /opt/bin/herdr  ", sshBin: " /usr/bin/ssh " });
    expect(config.herdrBin).toBe("/opt/bin/herdr");
    expect(config.sshBin).toBe("/usr/bin/ssh");
  });

  it("falls back to undefined for blank or non-string herdrBin/sshBin", () => {
    const config = readPluginConfig({ herdrBin: "   ", sshBin: 42 });
    expect(config).not.toHaveProperty("herdrBin");
    expect(config).not.toHaveProperty("sshBin");
  });

  it("parses nested remote.enabled and remote.allowSend", () => {
    const config = readPluginConfig({
      remote: { enabled: false, allowSend: [" buildbox ", "profile-2"] },
    });
    expect(config.remote).toEqual({ enabled: false, allowSend: ["buildbox", "profile-2"] });
  });

  it("accepts top-level remoteEnabled/remoteAllowSend aliases", () => {
    const config = readPluginConfig({ remoteEnabled: false, remoteAllowSend: ["buildbox"] });
    expect(config.remote).toEqual({ enabled: false, allowSend: ["buildbox"] });
  });

  it("prefers nested remote fields over top-level aliases, per key", () => {
    const config = readPluginConfig({
      remote: { enabled: false },
      remoteEnabled: true,
      remoteAllowSend: ["buildbox"],
    });
    // nested `enabled` wins over the top-level alias, but since nested has
    // no `allowSend`, the top-level alias is used for that field.
    expect(config.remote).toEqual({ enabled: false, allowSend: ["buildbox"] });
  });

  it("drops malformed allowSend entries and keeps the valid ones", () => {
    const config = readPluginConfig({
      remote: { allowSend: ["buildbox", "", "   ", 42, null, "  edge-node  "] },
    });
    expect(config.remote.allowSend).toEqual(["buildbox", "edge-node"]);
  });

  it("falls back to defaults for malformed remote values", () => {
    const config1 = readPluginConfig({ remote: "not-an-object" });
    expect(config1.remote).toEqual({ enabled: true, allowSend: [] });

    const config2 = readPluginConfig({ remote: { enabled: "yes", allowSend: "buildbox" } });
    expect(config2.remote).toEqual({ enabled: true, allowSend: [] });

    const config3 = readPluginConfig({ remote: null });
    expect(config3.remote).toEqual({ enabled: true, allowSend: [] });

    const config4 = readPluginConfig({ remote: ["buildbox"] });
    expect(config4.remote).toEqual({ enabled: true, allowSend: [] });
  });

  it("falls back to top-level alias when nested remote value is malformed", () => {
    const config = readPluginConfig({
      remote: { enabled: "not-a-boolean" },
      remoteEnabled: false,
    });
    expect(config.remote.enabled).toBe(false);
  });

  it("keeps every existing key and default exactly as before", () => {
    const config = readPluginConfig({
      socketPath: "/tmp/herdr.sock",
      requestTimeoutMs: 12_345,
      watchTimeoutMinutes: 5,
    });
    expect(config.socketPath).toBe("/tmp/herdr.sock");
    expect(config.requestTimeoutMs).toBe(12_345);
    expect(config.watchTimeoutMinutes).toBe(5);
    // `openclawBin`/`socketPath` are passed through verbatim (not trimmed),
    // matching the pre-existing `text()` behavior.
  });

  it("falls back to defaults for invalid numeric values", () => {
    const config = readPluginConfig({
      requestTimeoutMs: -1,
      watchTimeoutMinutes: "not-a-number",
    });
    expect(config.requestTimeoutMs).toBe(5_000);
    expect(config.watchTimeoutMinutes).toBe(720);
  });

  it("still clamps readLines to [1, 400]", () => {
    expect(readPluginConfig({ readLines: 0 }).readLines).toBe(40);
    expect(readPluginConfig({ readLines: -5 }).readLines).toBe(40);
    expect(readPluginConfig({ readLines: 0.5 }).readLines).toBe(1);
    expect(readPluginConfig({ readLines: 1000 }).readLines).toBe(400);
    expect(readPluginConfig({ readLines: 200 }).readLines).toBe(200);
  });
});
