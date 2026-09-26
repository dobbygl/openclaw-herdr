import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHerdrPlugin } from "../src/index.js";
import { activeRuntime } from "../src/openclaw/active-runtime.js";
import type { HostApi, HostTool, HostToolContext } from "../src/openclaw/host-api.js";
import { HerdrRuntime } from "../src/openclaw/runtime.js";

function host() {
  const factories: Array<(ctx: HostToolContext) => HostTool> = [];
  const services: Array<Parameters<HostApi["registerService"]>[0]> = [];
  const api: HostApi = {
    pluginConfig: { remote: { enabled: false } }, logger: {},
    registerCommand: () => {},
    registerTool: (factory) => { factories.push(factory); },
    registerService: (service) => { services.push(service); },
    session: { workflow: { enqueueNextTurnInjection: vi.fn() } },
  };
  const runtime = registerHerdrPlugin(api);
  return {
    runtime,
    start: () => services[0]!.start({ stateDir: "/unused", logger: {} }),
    stop: () => services[0]!.stop?.({ stateDir: "/unused", logger: {} }),
    tool: (name: string, ctx: HostToolContext) => factories.map((f) => f(ctx)).find((t) => t.name === name)!,
  };
}

afterEach(() => { activeRuntime.clearRuntime(); vi.restoreAllMocks(); });

describe("service runtime across plugin discovery registrations", () => {
  it("routes discovery tools to the started service, preserving each caller", async () => {
    vi.spyOn(HerdrRuntime.prototype, "start").mockResolvedValue();
    const service = host();
    await service.start();
    const discovery = host();
    const watch = vi.spyOn(service.runtime, "watch").mockResolvedValue("watching");
    const detached = vi.spyOn(discovery.runtime, "watch");
    for (const sessionKey of ["session-a", "session-b"]) {
      const tool = discovery.tool("herdr_watch", { sessionKey, agentId: "helper" });
      await tool.execute("call", { target: "sample#reviewer" });
      expect(watch).toHaveBeenLastCalledWith("sample#reviewer", { sessionKey, agentId: "helper" });
    }
    expect(detached).not.toHaveBeenCalled();
  });

  it("resolves the service at execution time, including after replacement", async () => {
    vi.spyOn(HerdrRuntime.prototype, "start").mockResolvedValue();
    vi.spyOn(HerdrRuntime.prototype, "stop").mockResolvedValue();
    const discovery = host();
    const tool = discovery.tool("herdr_watch", { sessionKey: "session-a" });
    const first = host();
    await first.start();
    const firstWatch = vi.spyOn(first.runtime, "watch").mockResolvedValue("first");
    await tool.execute("call", { target: "sample#reviewer" });
    expect(firstWatch).toHaveBeenCalledOnce();
    const replacement = host();
    await replacement.start();
    await first.stop();
    expect(activeRuntime.tryGetRuntime()).toBe(replacement.runtime);
    const nextWatch = vi.spyOn(replacement.runtime, "watch").mockResolvedValue("next");
    await tool.execute("call", { target: "sample#reviewer" });
    expect(nextWatch).toHaveBeenCalledOnce();
    await replacement.stop();
    expect(activeRuntime.tryGetRuntime()).toBeNull();
  });

  it("does not publish a runtime whose service failed to start", async () => {
    vi.spyOn(HerdrRuntime.prototype, "start").mockRejectedValue(new Error("startup failed"));
    const failed = host();
    await expect(failed.start()).rejects.toThrow("startup failed");
    expect(activeRuntime.tryGetRuntime()).toBeNull();
  });

  it("distinguishes missing caller context from an inactive service", async () => {
    const discovery = host();
    expect(await discovery.runtime.watch("sample#reviewer", {})).toBe(discovery.runtime.messages.watchNeedsSession);
    expect(await discovery.runtime.watch("sample#reviewer", { sessionKey: "session-a" })).toBe(discovery.runtime.messages.watcherNotRunning);
  });

  it("sends through the active service with the original caller and watch option", async () => {
    vi.spyOn(HerdrRuntime.prototype, "start").mockResolvedValue();
    const service = host();
    await service.start();
    const discovery = host();
    const send = vi.spyOn(service.runtime, "send").mockResolvedValue("sent");
    await discovery.tool("herdr_send", { sessionKey: "session-a" }).execute("call", {
      target: "sample#reviewer", text: "Review the example", watch: true,
    });
    expect(send).toHaveBeenCalledWith("sample#reviewer", "Review the example", { sessionKey: "session-a" }, true);
  });
});
