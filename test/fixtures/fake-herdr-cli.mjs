#!/usr/bin/env node
/**
 * A fake `herdr` CLI for the machine-catalog tests. Only `machine list --json`
 * is implemented.
 *
 * Environment:
 *  FAKE_HERDR_MODE   ok (default) | badjson | notarray | fail | hang | wrapped
 *  FAKE_HERDR_CALLS  append one line per invocation, so tests can count spawns
 *  FAKE_HERDR_MACHINES_FILE  JSON file with the rows to print instead of the
 *                    built-in herd, for tests that need their own machines
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_HERDR_CALLS) {
  fs.appendFileSync(process.env.FAKE_HERDR_CALLS, JSON.stringify(argv) + "\n");
}

if (argv.join(" ") !== "machine list --json") {
  process.stderr.write(`error: unrecognized subcommand ${JSON.stringify(argv.join(" "))}\n`, () => process.exit(2));
} else if (process.env.FAKE_HERDR_MACHINES_FILE) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_HERDR_MACHINES_FILE, "utf8"));
} else {
  const machines = [
    // Everything a usable machine has, plus a field from a future Herdr.
    {
      id: "abc123def4567890",
      label: "buildbox",
      target: "buildbox",
      session: "default",
      enabled: true,
      selected: false,
      future_field: "ignored",
    },
    // Disabled: must not be returned.
    { id: "bbb222", label: "oldbox", target: "alice@oldbox", session: "default", enabled: false, selected: false },
    // No id, so unusable.
    { id: "", label: "nameless", target: "alice@ghost", enabled: true },
    // A target ssh would read as an option: dropped at the boundary.
    { id: "ccc333", label: "sneaky", target: "-oProxyCommand=touch /tmp/pwned", enabled: true },
    // Not even an object.
    "not-a-machine",
    // No `enabled` field at all: kept, because unknown/absent fields are ignorable.
    { id: "ddd444", label: "lab", target: "alice@lab", session: "work" },
  ];

  const mode = process.env.FAKE_HERDR_MODE ?? "ok";
  switch (mode) {
    case "badjson":
      process.stdout.write("not json at all\n");
      break;
    case "notarray":
      process.stdout.write(JSON.stringify({ type: "machine_list" }) + "\n");
      break;
    case "wrapped":
      process.stdout.write(JSON.stringify({ type: "machine_list", machines }) + "\n");
      break;
    case "fail":
      process.stderr.write("error: no machines configured\n", () => process.exit(3));
      break;
    case "hang":
      setInterval(() => {}, 1000);
      break;
    default:
      process.stdout.write(JSON.stringify(machines) + "\n");
  }
}
