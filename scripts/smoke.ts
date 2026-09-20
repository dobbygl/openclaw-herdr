/**
 * Live check against the local Herdr server. Read-only: it never sends input.
 *   npm run smoke
 *
 * Any failure - including a subscription that is never acknowledged - prints
 * `FAIL: ...` and exits non-zero.
 */
import { HerdrClient } from "../src/herdr/client.js";

async function main(): Promise<void> {
  const client = new HerdrClient();
  const pong = await client.ping();
  console.log(`herdr ${pong.version} protocol ${pong.protocol} at ${client.socketPath}`);
  const agents = await client.listAgents();
  console.log(`${agents.length} agent pane(s)`);
  for (const agent of agents) {
    console.log(
      `- ${agent.pane_id} ${agent.name ?? ""} ${agent.agent ?? "no agent"} ${agent.agent_status} seq=${agent.state_change_seq ?? "?"} cwd=${agent.foreground_cwd ?? agent.cwd ?? "?"}`,
    );
  }
  const first = agents.find((agent) => agent.agent !== null);
  if (!first) {
    console.log("no live agent to inspect; skipping explain/read/subscribe");
    return;
  }
  const explain = await client.explain(first.pane_id);
  console.log("explain:", JSON.stringify(explain).slice(0, 300));
  const read = await client.readAgent(first.pane_id, { source: "visible", lines: 6 });
  console.log("tail:\n" + read.text);

  console.log("subscribing for 3s to pane.agent_status_changed …");
  let streamError: Error | undefined;
  const subscription = client.subscribe(
    [{ type: "pane.agent_status_changed", pane_id: first.pane_id }],
    (event) => console.log("event", JSON.stringify(event)),
    (error) => {
      streamError ??= error;
    },
  );
  try {
    // Require the ack: without it we would "watch" a pane nobody is streaming.
    await subscription.ready;
    console.log("subscription acknowledged");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (streamError) throw streamError;
  } finally {
    subscription.close();
  }
}

try {
  await main();
  console.log("ok");
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
