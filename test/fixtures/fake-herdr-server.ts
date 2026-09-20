import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

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
 *
 * Shared by the local socket tests and the ssh-stdio transport tests: the fake
 * `ssh` script proxies straight into this server, so both transports are
 * exercised against identical server behaviour.
 */
export interface FakeHerdr {
  readonly socketPath: string;
  readonly dir: string;
  /** Push one `pane.agent_status_changed` event to a live subscription. */
  emit(pane: string, status: string): void;
  close(): Promise<void>;
}

function paneOf(params: Record<string, unknown>): string {
  const subscriptions = Array.isArray(params.subscriptions) ? params.subscriptions : [];
  for (const spec of subscriptions) {
    if (spec && typeof spec === "object" && typeof (spec as { pane_id?: unknown }).pane_id === "string") {
      return (spec as { pane_id: string }).pane_id;
    }
  }
  return "*";
}

export async function startFakeHerdr(prefix = "herdr-fake-"): Promise<FakeHerdr> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(dir, "herdr.sock");
  const accepted = new Set<net.Socket>();
  const streams = new Map<string, net.Socket>();

  const server = net.createServer((socket) => {
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

  return {
    socketPath,
    dir,
    emit(pane: string, status: string) {
      streams
        .get(pane)
        ?.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: status } }) + "\n");
    },
    async close() {
      // `server.close` waits for open connections, and a live subscription socket
      // would keep it waiting forever: drop the sockets first.
      for (const socket of accepted) socket.destroy();
      accepted.clear();
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
