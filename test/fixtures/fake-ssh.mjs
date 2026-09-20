#!/usr/bin/env node
/**
 * A fake `ssh` for the transport tests. It ignores every option, then either
 *
 *  - proxies stdin/stdout to the fake Herdr Unix socket named by
 *    FAKE_HERDR_SOCKET (what `socat - UNIX-CONNECT:…` does remotely), or
 *  - prints a canned `herdr status server` block, when the remote command
 *    looks like one.
 *
 * With several fake machines in one test, each one needs its own fake Herdr
 * server: FAKE_SSH_SOCKET_MAP maps the ssh *target* to the socket to proxy to
 * (and, optionally, to the socket path `status server` reports for it), and
 * FAKE_HERDR_SOCKET stays the fallback for every other target.
 *
 * Environment:
 *  FAKE_HERDR_SOCKET   Unix socket to proxy to (required for the proxy mode)
 *  FAKE_SSH_SOCKET_MAP JSON {target: "<socket>"} or {target: {socket, status}}
 *  FAKE_SSH_STATUS_SOCKET  what the `status server` block reports
 *  FAKE_SSH_ARGV_FILE  append the received argv as one JSON line (assertions)
 *  FAKE_SSH_PID_FILE   append "<pid>\t<target>" per proxy child, so a test can
 *                      kill the live one (an ssh that dies mid-subscription)
 *  FAKE_SSH_FAIL       auth | hostkey | refused | missing-socket | no-tool |
 *                      no-socket-line | unsafe-socket-line
 *  FAKE_SSH_FAIL_TARGETS  comma-separated targets FAKE_SSH_FAIL applies to;
 *                      unset means every target (one machine down, not the herd)
 *  FAKE_SSH_DROP_MS    proxy, then die like a dropped ssh after N ms
 *  FAKE_SSH_DIE_ON_EOF when the remote end closes, exit like a dropped ssh
 *                      instead of ending cleanly
 */
import net from "node:net";
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_ARGV_FILE) {
  fs.appendFileSync(process.env.FAKE_SSH_ARGV_FILE, JSON.stringify(argv) + "\n");
}

/** Skip ssh's own options: `-o <value>` pairs and bare flags such as `-T`. */
function split(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-o" || arg === "-i" || arg === "-p" || arg === "-F") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return { target: args[index], command: args.slice(index + 1).join(" ") };
}

const { target, command } = split(argv);

/** The per-target entry of FAKE_SSH_SOCKET_MAP, if there is one. */
function mapping() {
  if (!process.env.FAKE_SSH_SOCKET_MAP) return undefined;
  const map = JSON.parse(process.env.FAKE_SSH_SOCKET_MAP);
  const entry = map[target];
  if (entry === undefined) return undefined;
  return typeof entry === "string" ? { socket: entry } : entry;
}

function die(message, code = 255) {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`, () => process.exit(code));
}

const FAILURES = {
  auth: "alice@buildbox: Permission denied (publickey).",
  hostkey:
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
  refused: "ssh: connect to host buildbox port 22: Connection refused",
  "missing-socket":
    'socat[4711] E connect(5, AF=1 "/home/alice/.config/herdr/herdr.sock", 45): No such file or directory',
  "no-tool": "bash: line 1: socat: command not found",
};

const failure = process.env.FAKE_SSH_FAIL ?? "";
const failTargets = (process.env.FAKE_SSH_FAIL_TARGETS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const failsHere = Boolean(failure) && (failTargets.length === 0 || failTargets.includes(target));

if (failsHere && FAILURES[failure]) {
  die(FAILURES[failure]);
} else if (/\bstatus\s+server\b/.test(command)) {
  // The remote `herdr status server` block, trimmed to the lines we parse.
  if (failsHere && failure === "no-socket-line") {
    process.stdout.write("running: true\nprotocol: 22\n");
    process.exit(0);
  }
  const reported =
    failsHere && failure === "unsafe-socket-line"
      ? "/home/alice/.config/herdr/$(whoami).sock"
      : (mapping()?.status ?? process.env.FAKE_SSH_STATUS_SOCKET ?? "/home/alice/.config/herdr/herdr.sock");
  process.stdout.write(
    [
      "herdr 0.9.1",
      "running: true",
      `socket: ${reported}`,
      "protocol: 22",
      "",
    ].join("\n"),
  );
  process.exit(0);
} else {
  const socketPath = mapping()?.socket ?? process.env.FAKE_HERDR_SOCKET;
  if (!socketPath) die("fake-ssh: FAKE_HERDR_SOCKET is not set", 2);
  if (process.env.FAKE_SSH_PID_FILE) {
    fs.appendFileSync(process.env.FAKE_SSH_PID_FILE, `${process.pid}\t${target}\n`);
  }

  const socket = net.connect(socketPath);
  socket.on("error", (error) => die(`socat[4711] E connect(5, AF=1 "${socketPath}", 45): ${error.message}`));
  socket.on("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout, { end: false });
  });
  // Let the process end naturally once stdout has drained: stop reading stdin
  // instead of calling process.exit, which could truncate the last line.
  socket.on("close", () => {
    if (process.env.FAKE_SSH_DIE_ON_EOF) {
      die(`Connection to ${target} closed by remote host.`);
      return;
    }
    process.stdin.pause();
    process.stdin.destroy();
  });

  const dropMs = Number(process.env.FAKE_SSH_DROP_MS ?? 0);
  if (dropMs > 0) {
    setTimeout(() => die("Connection to buildbox closed by remote host."), dropMs);
  }
}
