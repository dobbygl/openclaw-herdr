#!/usr/bin/env node
/**
 * A fake `ssh` for the transport tests. It ignores every option, then either
 *
 *  - proxies stdin/stdout to the fake Herdr Unix socket named by
 *    FAKE_HERDR_SOCKET (what `socat - UNIX-CONNECT:…` does remotely), or
 *  - prints a canned `herdr status server` block, when the remote command
 *    looks like one.
 *
 * Environment:
 *  FAKE_HERDR_SOCKET   Unix socket to proxy to (required for the proxy mode)
 *  FAKE_SSH_STATUS_SOCKET  what the `status server` block reports
 *  FAKE_SSH_ARGV_FILE  append the received argv as one JSON line (assertions)
 *  FAKE_SSH_FAIL       auth | hostkey | refused | missing-socket | no-tool |
 *                      no-socket-line | unsafe-socket-line
 *  FAKE_SSH_DROP_MS    proxy, then die like a dropped ssh after N ms
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

const { command } = split(argv);

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
if (failure && FAILURES[failure]) {
  die(FAILURES[failure]);
} else if (/\bstatus\s+server\b/.test(command)) {
  // The remote `herdr status server` block, trimmed to the lines we parse.
  if (failure === "no-socket-line") {
    process.stdout.write("running: true\nprotocol: 22\n");
    process.exit(0);
  }
  const reported =
    failure === "unsafe-socket-line"
      ? "/home/alice/.config/herdr/$(whoami).sock"
      : (process.env.FAKE_SSH_STATUS_SOCKET ?? "/home/alice/.config/herdr/herdr.sock");
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
  const socketPath = process.env.FAKE_HERDR_SOCKET;
  if (!socketPath) die("fake-ssh: FAKE_HERDR_SOCKET is not set", 2);

  const socket = net.connect(socketPath);
  socket.on("error", (error) => die(`socat[4711] E connect(5, AF=1 "${socketPath}", 45): ${error.message}`));
  socket.on("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout, { end: false });
  });
  // Let the process end naturally once stdout has drained: stop reading stdin
  // instead of calling process.exit, which could truncate the last line.
  socket.on("close", () => {
    process.stdin.pause();
    process.stdin.destroy();
  });

  const dropMs = Number(process.env.FAKE_SSH_DROP_MS ?? 0);
  if (dropMs > 0) {
    setTimeout(() => die("Connection to buildbox closed by remote host."), dropMs);
  }
}
