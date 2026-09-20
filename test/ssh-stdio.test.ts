import { describe, expect, it } from "vitest";
import { HerdrTransportError } from "../src/herdr/client.js";
import {
  SSH_FIXED_OPTIONS,
  assertSafeRemotePath,
  assertSafeRemoteWord,
  assertSshTarget,
  buildRemoteCommand,
  buildSshArgv,
  classifySshFailure,
  createSshConnectionFactory,
  isSafeRemotePath,
  sshOptionArgs,
} from "../src/herdr/ssh-stdio.js";

const SOCKET = "/home/alice/.config/herdr/herdr.sock";

describe("remote path validation", () => {
  it("accepts a realistic Herdr socket path", () => {
    expect(isSafeRemotePath(SOCKET)).toBe(true);
    expect(isSafeRemotePath("/run/user/1000/herdr/herdr-2.sock")).toBe(true);
    expect(assertSafeRemotePath(SOCKET)).toBe(SOCKET);
  });

  it("requires an absolute path", () => {
    expect(() => assertSafeRemotePath(".config/herdr/herdr.sock")).toThrow(/must be absolute/u);
    expect(() => assertSafeRemotePath("~/.config/herdr/herdr.sock")).toThrow(/must be absolute/u);
  });

  it("refuses anything a remote shell could act on", () => {
    // The remote side of `ssh <target> <command>` is a login shell, so these
    // must never reach it.
    for (const bad of [
      "/tmp/a b.sock",
      "/tmp/a;rm -rf /",
      "/tmp/$(whoami).sock",
      "/tmp/`id`.sock",
      "/tmp/a|b",
      "/tmp/a&b",
      "/tmp/a>b",
      "/tmp/a'b",
      '/tmp/a"b',
      "/tmp/a\nb",
      "/tmp/a*",
      "/tmp/a$HOME",
      "/tmp/a\\b",
      "",
    ]) {
      expect(isSafeRemotePath(bad)).toBe(false);
      expect(() => assertSafeRemotePath(bad)).toThrow(HerdrTransportError);
    }
  });

  it("applies the same rule to bare remote words", () => {
    expect(assertSafeRemoteWord("work")).toBe("work");
    expect(assertSafeRemoteWord("herdr")).toBe("herdr");
    expect(() => assertSafeRemoteWord("work; rm -rf /")).toThrow(HerdrTransportError);
    expect(() => assertSafeRemoteWord("")).toThrow(HerdrTransportError);
  });
});

describe("ssh target validation", () => {
  it("accepts hosts, user@host and bracketed IPv6", () => {
    for (const good of ["buildbox", "alice@buildbox", "alice@buildbox.example", "[2001:db8::1]", "alice@10.0.0.4"]) {
      expect(assertSshTarget(good)).toBe(good);
    }
  });

  it("refuses a target ssh would read as an option", () => {
    expect(() => assertSshTarget("-oProxyCommand=touch /tmp/pwned")).toThrow(/not usable/u);
    expect(() => assertSshTarget("--")).toThrow(/not usable/u);
  });

  it("refuses whitespace and shell characters in a target", () => {
    for (const bad of ["build box", "alice@box;id", "alice@box$(id)", ""]) {
      expect(() => assertSshTarget(bad)).toThrow(HerdrTransportError);
    }
  });
});

describe("remote command", () => {
  it("uses socat by default", () => {
    expect(buildRemoteCommand("socat", SOCKET)).toBe(`socat - UNIX-CONNECT:${SOCKET}`);
  });

  it("builds a single-quoted python bridge that contains no single quote", () => {
    const command = buildRemoteCommand("python", SOCKET);
    expect(command.startsWith("python3 -c '")).toBe(true);
    expect(command.endsWith("'")).toBe(true);
    // Exactly the two quotes we added: nothing inside can close the quoting.
    expect(command.split("'").length - 1).toBe(2);
    expect(command).toContain(`s.connect("${SOCKET}")`);
    expect(command).toContain("AF_UNIX");
  });

  it("validates the path before it reaches the command", () => {
    expect(() => buildRemoteCommand("socat", "/tmp/a;id")).toThrow(HerdrTransportError);
    expect(() => buildRemoteCommand("python", "/tmp/a'b")).toThrow(HerdrTransportError);
  });
});

describe("buildSshArgv", () => {
  it("passes the fixed options, then the target, then one command word", () => {
    const argv = buildSshArgv({
      target: "buildbox",
      remoteCommand: `socat - UNIX-CONNECT:${SOCKET}`,
      controlPath: "/tmp/state/cm-buildbox",
    });
    expect(argv).toEqual([
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=120",
      "-o", "ControlPath=/tmp/state/cm-buildbox",
      "-T",
      "buildbox",
      `socat - UNIX-CONNECT:${SOCKET}`,
    ]);
  });

  it("omits ControlPath when the caller has no state dir for it", () => {
    const argv = sshOptionArgs();
    expect(argv.filter((arg) => arg.startsWith("ControlPath="))).toEqual([]);
    expect(argv).toHaveLength(SSH_FIXED_OPTIONS.length * 2 + 1);
    expect(argv.at(-1)).toBe("-T");
  });

  it("refuses a newline in ControlPath", () => {
    expect(() => sshOptionArgs("/tmp/cm\nProxyCommand=id")).toThrow(HerdrTransportError);
  });
});

describe("createSshConnectionFactory", () => {
  it("validates at setup, before any spawn", () => {
    expect(() => createSshConnectionFactory({ target: "buildbox", socketPath: "relative.sock" })).toThrow(
      /must be absolute/u,
    );
    expect(() => createSshConnectionFactory({ target: "-oProxyCommand=id", socketPath: SOCKET })).toThrow(
      /target is not usable/u,
    );
    expect(() => createSshConnectionFactory({ target: "buildbox", socketPath: "/tmp/a b.sock" })).toThrow(
      HerdrTransportError,
    );
  });
});

describe("classifySshFailure", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["alice@buildbox: Permission denied (publickey).", /authentication failed/u],
    ["Host key verification failed.", /host key verification failed/u],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", /host key verification failed/u],
    ["ssh: connect to host buildbox port 22: Connection refused", /ssh could not connect/u],
    ["ssh: Could not resolve hostname buildbox: Name or service not known", /could not be resolved/u],
    ["ssh: connect to host buildbox port 22: Connection timed out", /timed out/u],
    ["Connection to buildbox closed by remote host.", /connection dropped/u],
    ["bash: line 1: socat: command not found", /not installed/u],
    ['socat[1] E connect(5, AF=1 "/home/alice/.config/herdr/herdr.sock", 45): No such file or directory', /does not exist/u],
    ['socat[1] E connect(5, AF=1 "/home/alice/.config/herdr/herdr.sock", 45): Connection refused', /socket refused/u],
    ["FileNotFoundError: [Errno 2] No such file or directory", /does not exist/u],
    ["PermissionError: [Errno 13] Permission denied", /permission denied on the remote/u],
  ];

  for (const [stderr, expected] of cases) {
    it(`maps ${JSON.stringify(stderr.slice(0, 40))}`, () => {
      expect(classifySshFailure({ code: 255, signal: null, stderr })).toMatch(expected);
    });
  }

  it("falls back to the exit code and first stderr line", () => {
    expect(classifySshFailure({ code: 42, signal: null, stderr: "something odd\nmore" })).toBe(
      "ssh exited with code 42: something odd",
    );
    expect(classifySshFailure({ code: null, signal: null, stderr: "" })).toBe("ssh exited with code unknown");
    expect(classifySshFailure({ code: null, signal: "SIGKILL", stderr: "" })).toBe("ssh was killed by SIGKILL");
  });
});
