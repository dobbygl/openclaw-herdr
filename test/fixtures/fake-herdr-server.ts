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
 * exercised against identical server behaviour. Several of these can run at
 * once (one per fake machine), each with its own herd: see {@link FakeHerdrOptions}.
 */
export interface FakeHerdrOptions {
  /**
   * Rows `agent.list` answers with. The default is the compatibility-torture
   * list (an unknown field, an unknown status, an unaddressable row and a row
   * that is not an object). `agent.get` is seeded from the usable rows.
   */
  agents?: unknown[];
  /** What `agent.read` returns for every pane. Defaults to an empty composer. */
  readText?: string;
}

/** A Herdr error response: the server answered, and said no. */
export interface FakeHerdrError {
  code: string;
  message: string;
}

export interface FakeHerdr {
  readonly socketPath: string;
  readonly dir: string;
  /** Push one `pane.agent_status_changed` event to a live subscription. */
  emit(pane: string, status: string): void;
  /** Every `agent.prompt` this server accepted, in order. */
  readonly prompts: Array<{ target: string; text: string }>;
  readonly created: Array<{ label: string; cwd: string | undefined }>;
  readonly starts: Array<{ name: string; kind: string; paneId: string; args: string[] | undefined }>;
  /** Adds a plain shell pane (no agent) that `pane.list` reports and `agent.start` can use. */
  addShellPane(paneId: string, label?: string): void;
  /** Pane id of every `events.subscribe` this server accepted, in order. */
  readonly subscribes: string[];
  /** Patches what `agent.get` reports for one pane. */
  setAgent(pane: string, patch: Record<string, unknown>): void;
  /** Replaces the whole herd: `agent.list` rows and the `agent.get` seeds. */
  setAgents(rows: unknown[]): void;
  /** What `agent.read` answers with from now on. */
  setReadText(text: string): void;
  /**
   * Makes `agent.list` answer with a Herdr error instead of a herd: the server
   * is up and refusing, which says nothing about the machine's health.
   */
  setListError(error: FakeHerdrError | undefined): void;
  /**
   * Drops every live subscription socket while the server keeps listening:
   * what a Herdr restart (or an ssh connection that died) looks like to a
   * client that must reconnect on its own.
   */
  dropStreams(): void;
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

const DEFAULT_AGENTS: unknown[] = [
  // A future Herdr field we must ignore, per the compatibility rule.
  { pane_id: "w1:p1", terminal_id: "term_1", agent: "claude", agent_status: "idle", vibe: "great" },
  // An agent_status this client has never heard of.
  { pane_id: "w1:p2", terminal_id: "term_2", agent: "codex", agent_status: "meditating" },
  // Unaddressable rows: no terminal_id, and not even an object.
  { pane_id: "w1:p3", agent: "claude", agent_status: "idle" },
  "not-an-agent",
];

/** `agent.get` seeds for the default herd; kept apart so a patch can move them. */
const DEFAULT_PANES: Array<[string, Record<string, unknown>]> = [
  ["w1:p1", { pane_id: "w1:p1", terminal_id: "term_1", agent: "claude", agent_status: "idle" }],
  ["w1:p2", { pane_id: "w1:p2", terminal_id: "term_2", agent: "codex", agent_status: "idle" }],
];

/** The `agent.get` seeds a custom herd implies: every addressable row, as given. */
function seedPanes(rows: unknown[]): Array<[string, Record<string, unknown>]> {
  const seeds: Array<[string, Record<string, unknown>]> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.pane_id !== "string" || typeof record.terminal_id !== "string") continue;
    seeds.push([record.pane_id, { ...record }]);
  }
  return seeds;
}

export async function startFakeHerdr(prefix = "herdr-fake-", options: FakeHerdrOptions = {}): Promise<FakeHerdr> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(dir, "herdr.sock");
  const accepted = new Set<net.Socket>();
  const streams = new Map<string, net.Socket>();
  const prompts: Array<{ target: string; text: string }> = [];
  const shellPanes: Array<{ pane_id: string; workspace_id: string; tab_id: string; label: unknown; agent: null; cwd: unknown }> = [];
  const created: Array<{ label: string; cwd: string | undefined }> = [];
  const starts: Array<{ name: string; kind: string; paneId: string; args: string[] | undefined }> = [];
  const subscribes: string[] = [];
  let agents: unknown[] = [...(options.agents ?? DEFAULT_AGENTS)];
  let readText = options.readText ?? "❯ \n";
  let listError: FakeHerdrError | undefined;
  /** What `agent.get` reports, per pane. Mutable, so a task can "finish". */
  const panes = new Map<string, Record<string, unknown>>(
    options.agents ? seedPanes(options.agents) : DEFAULT_PANES,
  );

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
          if (listError) reply({ id: "", error: listError });
          else reply({ id: request.id, result: { type: "agent_list", agents } });
          socket.end();
          break;
        case "agent.get": {
          const pane = panes.get(String(request.params.target ?? ""));
          if (!pane) reply({ id: "", error: { code: "not_found", message: `no agent on ${String(request.params.target)}` } });
          else reply({ id: request.id, result: { type: "agent_get", agent: pane } });
          socket.end();
          break;
        }
        case "pane.list":
          reply({
            id: request.id,
            result: {
              type: "pane_list",
              panes: [
                ...agents.map((row) => ({ ...(row as Record<string, unknown>) })),
                ...shellPanes,
              ],
            },
          });
          socket.end();
          break;
        case "tab.create": {
          const paneId = `w1:p${90 + shellPanes.length}`;
          const pane = { pane_id: paneId, workspace_id: "w1", tab_id: `w1:t${90 + shellPanes.length}`, label: request.params.label ?? null, agent: null, cwd: request.params.cwd ?? "/home/alice" };
          shellPanes.push(pane);
          created.push({ label: String(request.params.label ?? ""), cwd: request.params.cwd === undefined ? undefined : String(request.params.cwd) });
          reply({ id: request.id, result: { type: "tab_created", tab: { tab_id: pane.tab_id, label: pane.label }, root_pane: pane } });
          socket.end();
          break;
        }
        case "agent.start": {
          const paneId = String(request.params.pane_id ?? "");
          const shell = shellPanes.find((pane) => pane.pane_id === paneId);
          if (!shell) {
            reply({ id: "", error: { code: "pane_not_available", message: `${paneId} is not an available shell pane` } });
          } else if (request.params.kind === "nope") {
            reply({ id: "", error: { code: "unsupported_kind", message: "nope is not a supported agent kind" } });
          } else {
            const agent = {
              pane_id: paneId, workspace_id: "w1", tab_id: shell.tab_id, terminal_id: `term_${paneId.replace(":", "")}`,
              agent: String(request.params.kind ?? "claude"), name: String(request.params.name ?? ""), agent_status: "idle",
              focused: false, revision: 1, state_change_seq: 1, cwd: shell.cwd,
            };
            shellPanes.splice(shellPanes.indexOf(shell), 1);
            agents.push(agent);
            panes.set(paneId, agent);
            starts.push({ name: agent.name, kind: agent.agent, paneId, args: Array.isArray(request.params.args) ? (request.params.args as string[]) : undefined });
            reply({ id: request.id, result: { type: "agent_started", agent } });
          }
          socket.end();
          break;
        }
        case "agent.prompt":
          prompts.push({ target: String(request.params.target ?? ""), text: String(request.params.text ?? "") });
          reply({ id: request.id, result: { type: "prompt_submitted", submitted: true } });
          socket.end();
          break;
        case "agent.read":
          reply({
            id: request.id,
            result: {
              type: "pane_read",
              read: { pane_id: String(request.params.target ?? "w1:p1"), text: readText, revision: 3 },
            },
          });
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
          subscribes.push(pane);
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
    prompts,
    created,
    starts,
    addShellPane(paneId: string, label?: string) {
      shellPanes.push({ pane_id: paneId, workspace_id: "w1", tab_id: `w1:t${paneId.replace(/\D/gu, "")}`, label: label ?? null, agent: null, cwd: "/home/alice" });
    },
    subscribes,
    setAgent(pane: string, patch: Record<string, unknown>) {
      panes.set(pane, { ...(panes.get(pane) ?? { pane_id: pane, terminal_id: "term_1", agent: "claude" }), ...patch });
    },
    setAgents(rows: unknown[]) {
      agents = rows;
      panes.clear();
      for (const [pane, seed] of seedPanes(rows)) panes.set(pane, seed);
    },
    setReadText(text: string) {
      readText = text;
    },
    setListError(error: FakeHerdrError | undefined) {
      listError = error;
    },
    emit(pane: string, status: string) {
      streams
        .get(pane)
        ?.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: status } }) + "\n");
    },
    dropStreams() {
      for (const socket of streams.values()) socket.destroy();
      streams.clear();
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
