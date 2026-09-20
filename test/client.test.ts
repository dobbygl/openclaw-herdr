import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../src/herdr/client.js";

/**
 * A fake Herdr server that mimics the real framing: one JSON line in, one JSON
 * line out, then close; except events.subscribe, which acks and streams.
 *
 * Special targets let one server cover the unhappy paths:
 *  - `never:ack`  subscribe without ever acknowledging (ack timeout)
 *  - `bad:pane`   answer subscribe with an error ack
 *  - `flood:pane` ack, then stream a line that never ends (framing overflow)
 *  - `agent.wait` is never answered, so the request budget decides
 *  - `oversize`   answers a plain request with an unterminated line
 */
let server: net.Server;
let dir: string;
let socketPath: string;
const accepted = new Set<net.Socket>();
const streams = new Map<string, net.Socket>();

function paneOf(params: Record<string, unknown>): string {
  const subscriptions = Array.isArray(params.subscriptions) ? params.subscriptions : [];
  for (const spec of subscriptions) {
    if (spec && typeof spec === "object" && typeof (spec as { pane_id?: unknown }).pane_id === "string") {
      return (spec as { pane_id: string }).pane_id;
    }
  }
  return "*";
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-fake-"));
  socketPath = path.join(dir, "herdr.sock");
  server = net.createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {}); // the client destroys sockets; never crash the fake
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      buffer = buffer.slice(index + 1);
      const reply = (body: unknown) => socket.write(JSON.stringify(body) + "\n");
      switch (request.method) {
        case "ping":
          reply({ id: request.id, result: { type: "pong", version: "0.9.1", protocol: 22 } });
          socket.end();
          break;
        case "agent.list":
          reply({
            id: request.id,
            result: {
              type: "agent_list",
              agents: [
                // A future Herdr field we must ignore, per the compatibility rule.
                { pane_id: "w1:p1", terminal_id: "term_1", agent: "claude", agent_status: "idle", vibe: "great" },
                // An agent_status this client has never heard of.
                { pane_id: "w1:p2", terminal_id: "term_2", agent: "codex", agent_status: "meditating" },
                // Unaddressable rows: no terminal_id, and not even an object.
                { pane_id: "w1:p3", agent: "claude", agent_status: "idle" },
                "not-an-agent",
              ],
            },
          });
          socket.end();
          break;
        case "agent.read":
          reply({ id: request.id, result: { type: "pane_read", read: { pane_id: "w1:p1", text: "❯ \n", revision: 3 } } });
          socket.end();
          break;
        case "agent.wait":
          break; // never answers
        case "oversize":
          socket.write("x".repeat(Number(request.params.chars ?? 0)));
          break;
        case "events.subscribe": {
          const pane = paneOf(request.params);
          if (pane === "never:ack") break;
          if (pane === "bad:pane") {
            reply({ id: "", error: { code: "invalid_request", message: "unknown pane bad:pane" } });
            socket.end();
            break;
          }
          reply({ id: request.id, result: { type: "subscription_started" } });
          if (pane === "flood:pane") {
            // After the ack, and in its own chunk, so the client is already streaming.
            setTimeout(() => {
              if (!socket.destroyed) socket.write("y".repeat(4096));
            }, 25);
            break;
          }
          streams.set(pane, socket);
          break;
        }
        default:
          reply({ id: "", error: { code: "invalid_request", message: `unknown variant \`${request.method}\`` } });
          socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterAll(async () => {
  // `server.close` waits for open connections, and a live subscription socket
  // would keep it waiting forever: drop the sockets first.
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  streams.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

const emit = (pane: string, status: string) =>
  streams.get(pane)?.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: status } }) + "\n");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HerdrClient", () => {
  it("opens one connection per request and parses results", async () => {
    const client = new HerdrClient({ socketPath });
    expect((await client.ping()).protocol).toBe(22);
    expect((await client.readAgent("w1:p1", { lines: 2 })).text).toContain("❯");
  });

  it("validates agents at the boundary but keeps unknown fields", async () => {
    const client = new HerdrClient({ socketPath });
    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.pane_id)).toEqual(["w1:p1", "w1:p2"]);
    expect(agents[0]?.agent_status).toBe("idle");
    expect((agents[0] as unknown as { vibe?: string }).vibe).toBe("great");
    expect(agents[1]?.agent_status).toBe("unknown");
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
    await subscription.ready;
    emit("w1:p1", "working");
    emit("w1:p1", "idle");
    await delay(50);
    subscription.close();
    await subscription.closed;
    expect(events).toEqual(["pane.agent_status_changed:working", "pane.agent_status_changed:idle"]);
  });

  it("keeps simultaneous subscriptions independent", async () => {
    const client = new HerdrClient({ socketPath });
    const first: string[] = [];
    const second: string[] = [];
    const a = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }], (e) =>
      first.push(String(e.data.agent_status)),
    );
    const b = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p2" }], (e) =>
      second.push(String(e.data.agent_status)),
    );
    await Promise.all([a.ready, b.ready]);
    emit("w1:p1", "done");
    emit("w1:p2", "blocked");
    await delay(50);
    a.close();
    await a.closed;
    emit("w1:p2", "idle");
    await delay(50);
    expect(first).toEqual(["done"]);
    expect(second).toEqual(["blocked", "idle"]);
    b.close();
    await b.closed;
  });

  it("rejects ready on an error ack", async () => {
    const client = new HerdrClient({ socketPath });
    const errors: Error[] = [];
    const subscription = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "bad:pane" }],
      () => {},
      (error) => errors.push(error),
    );
    await expect(subscription.ready).rejects.toBeInstanceOf(HerdrRequestError);
    await subscription.closed;
    expect(errors[0]).toBeInstanceOf(HerdrRequestError);
  });

  it("rejects ready and closes the socket when the ack never arrives", async () => {
    const client = new HerdrClient({ socketPath, subscribeAckTimeoutMs: 120 });
    const subscription = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "never:ack" }], () => {});
    await expect(subscription.ready).rejects.toThrow(/did not acknowledge/u);
    // Destroying the socket is what lets a caller notice and reconnect.
    await subscription.closed;
  });

  it("fails a request whose line never ends", async () => {
    const client = new HerdrClient({ socketPath, maxLineLength: 1024, requestTimeoutMs: 2_000 });
    await expect(client.request("oversize", { chars: 4096 })).rejects.toThrow(/oversized line/u);
  });

  it("reports an oversized line on a live subscription", async () => {
    const client = new HerdrClient({ socketPath, maxLineLength: 1024 });
    const errors: Error[] = [];
    const subscription = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "flood:pane" }],
      () => {},
      (error) => errors.push(error),
    );
    await subscription.ready;
    await subscription.closed;
    expect(errors[0]).toBeInstanceOf(HerdrTransportError);
    expect(errors[0]?.message).toMatch(/oversized line/u);
  });

  it("stretches the request timeout to cover a server-side wait", async () => {
    const client = new HerdrClient({ socketPath, requestTimeoutMs: 120, waitGraceMs: 60 });
    const started = Date.now();
    await expect(client.waitFor("w1:p1", ["idle"], 400)).rejects.toThrow(/timed out after 460ms/u);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  it("honours a per-request timeout override", async () => {
    const client = new HerdrClient({ socketPath, requestTimeoutMs: 5_000 });
    await expect(client.waitFor("w1:p1", ["idle"], 60_000, { requestTimeoutMs: 80 })).rejects.toThrow(
      /timed out after 80ms/u,
    );
  });

  it("uses no transport timeout for an unbounded wait", async () => {
    const client = new HerdrClient({ socketPath, requestTimeoutMs: 100 });
    const pending = client.waitFor("w1:p1", ["idle"]);
    pending.catch(() => {}); // settles only when afterAll drops the socket
    const outcome = await Promise.race([pending.then(() => "settled", () => "settled"), delay(300).then(() => "pending")]);
    expect(outcome).toBe("pending");
  });

  it("fails fast when the socket does not exist", async () => {
    const client = new HerdrClient({ socketPath: path.join(os.tmpdir(), "definitely-missing.sock"), requestTimeoutMs: 500 });
    await expect(client.ping()).rejects.toThrow(/Cannot|ENOENT|socket/u);
  });
});
