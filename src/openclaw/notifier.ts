import type { Notifier, SettledStatus } from "../core/watcher.js";
import type { WatchRecord } from "../core/watch-store.js";
import type { HostApi } from "./host-api.js";

/**
 * Delivers a watch result back to the OpenClaw session that asked for it.
 *
 * Two host seams, both in-process:
 *  1. `enqueueNextTurnInjection` stores the text so the next agent turn in that
 *     session sees it (survives a Gateway restart; idempotent per event).
 *  2. `requestHeartbeat` asks the Gateway to run a turn now instead of waiting
 *     for the user to speak, so the message reaches the chat promptly.
 */
export class OpenClawNotifier implements Notifier {
  constructor(private readonly api: HostApi) {}

  async notify(watch: WatchRecord, status: SettledStatus, text: string): Promise<void> {
    const injection = await this.api.session.workflow.enqueueNextTurnInjection({
      sessionKey: watch.sessionKey,
      ...(watch.agentId ? { agentId: watch.agentId } : {}),
      text: [
        "[Herdr watch event] Relay the following to the user as-is (short, phone-friendly). Do not poll the terminal yourself.",
        text,
      ].join("\n"),
      idempotencyKey: `herdr:${watch.id}:${status}`,
      placement: "append_context",
      ttlMs: 24 * 60 * 60 * 1000,
      metadata: { kind: "herdr-watch", watchId: watch.id, paneId: watch.paneId, status },
    });
    this.api.logger.info?.(`herdr: queued ${status} for ${watch.paneId} → ${injection.sessionKey} (${injection.id})`);
    this.api.runtime?.system?.requestHeartbeat?.({
      source: "other",
      intent: "event",
      reason: `herdr ${status} ${watch.paneId}`,
      sessionKey: watch.sessionKey,
      ...(watch.agentId ? { agentId: watch.agentId } : {}),
    });
  }
}
