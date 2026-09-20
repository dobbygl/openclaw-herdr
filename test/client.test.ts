import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrClient, HerdrRequestError, HerdrTransportError } from "../src/herdr/client.js";
import { type FakeHerdr, startFakeHerdr } from "./fixtures/fake-herdr-server.js";

/**
 * The fake Herdr server lives in test/fixtures so the ssh-stdio transport tests
 * can proxy into the very same server; see fake-herdr-server.ts for the special
 * targets that drive the unhappy paths.
 */
let herdr: FakeHerdr;
let socketPath: string;

beforeAll(async () => {
  herdr = await startFakeHerdr();
  socketPath = herdr.socketPath;
});

afterAll(async () => {
  await herdr.close();
});

const emit = (pane: string, status: string) => herdr.emit(pane, status);
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
