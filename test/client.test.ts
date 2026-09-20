import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError } from "../src/herdr/client.js";

/**
 * A fake Herdr server that mimics the real framing: one JSON line in, one JSON
 * line out, then close; except events.subscribe, which acks and streams.
 */
let server: net.Server;
let socketPath: string;
let streamSocket: net.Socket | undefined;

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-fake-"));
  socketPath = path.join(dir, "herdr.sock");
  server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index)) as { id: string; method: string; params: Record<string, unknown> };
      const reply = (body: unknown) => socket.write(JSON.stringify(body) + "\n");
      switch (request.method) {
        case "ping":
          reply({ id: request.id, result: { type: "pong", version: "0.9.1", protocol: 22 } });
          socket.end();
          break;
        case "agent.list":
          reply({ id: request.id, result: { type: "agent_list", agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }] } });
          socket.end();
          break;
        case "agent.read":
          reply({ id: request.id, result: { type: "pane_read", read: { pane_id: "w1:p1", text: "❯ \n", revision: 3 } } });
          socket.end();
          break;
        case "events.subscribe":
          streamSocket = socket;
          reply({ id: request.id, result: { type: "subscription_started" } });
          break;
        default:
          reply({ id: "", error: { code: "invalid_request", message: `unknown variant \`${request.method}\`` } });
          socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HerdrClient", () => {
  it("opens one connection per request and parses results", async () => {
    const client = new HerdrClient({ socketPath });
    expect((await client.ping()).protocol).toBe(22);
    const agents = await client.listAgents();
    expect(agents[0]?.pane_id).toBe("w1:p1");
    expect((await client.readAgent("w1:p1", { lines: 2 })).text).toContain("❯");
  });

  it("turns error responses into HerdrRequestError", async () => {
    const client = new HerdrClient({ socketPath });
    await expect(client.request("no.such")).rejects.toBeInstanceOf(HerdrRequestError);
  });

  it("streams subscription events until closed", async () => {
    const client = new HerdrClient({ socketPath });
    const events: string[] = [];
    const subscription = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }], (event) =>
      events.push(`${event.event}:${String(event.data.agent_status)}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    streamSocket?.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } }) + "\n");
    streamSocket?.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    subscription.close();
    await subscription.closed;
    expect(events).toEqual(["pane.agent_status_changed:working", "pane.agent_status_changed:idle"]);
  });

  it("fails fast when the socket does not exist", async () => {
    const client = new HerdrClient({ socketPath: path.join(os.tmpdir(), "definitely-missing.sock"), requestTimeoutMs: 500 });
    await expect(client.ping()).rejects.toThrow(/Cannot|ENOENT|socket/u);
  });
});
