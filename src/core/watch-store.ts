import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WatchRecord {
  id: string;
  paneId: string;
  terminalId: string;
  agentLabel: string;
  /** OpenClaw session that asked; notifications go back there. */
  sessionKey: string;
  agentId?: string;
  promptPreview: string;
  createdAt: string;
  deadlineAt: string;
  /** Herdr state_change_seq observed when the watch started; older events are ignored. */
  seqAtStart: number;
  lastStatus?: string;
}

interface StoreFile {
  version: 1;
  watches: WatchRecord[];
}

/**
 * Durable list of active watches. One small JSON file, rewritten atomically.
 * It only holds routing state; Herdr remains the source of truth for what the
 * agent is doing.
 */
export class WatchStore {
  #file: string;
  #watches: WatchRecord[] = [];
  #loaded = false;
  #writes: Promise<void> = Promise.resolve();
  #tmpCounter = 0;

  constructor(stateDir: string) {
    this.#file = path.join(stateDir, "watches.json");
  }

  get file(): string {
    return this.#file;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      this.#watches = Array.isArray(parsed.watches) ? parsed.watches : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#watches = [];
    }
    this.#loaded = true;
  }

  list(): WatchRecord[] {
    this.#assertLoaded();
    return [...this.#watches];
  }

  byPane(paneId: string): WatchRecord | undefined {
    this.#assertLoaded();
    return this.#watches.find((watch) => watch.paneId === paneId);
  }

  async add(input: Omit<WatchRecord, "id" | "createdAt">): Promise<WatchRecord> {
    this.#assertLoaded();
    this.#watches = this.#watches.filter((watch) => watch.paneId !== input.paneId);
    const record: WatchRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#watches.push(record);
    await this.#save();
    return record;
  }

  async update(id: string, patch: Partial<WatchRecord>): Promise<void> {
    this.#assertLoaded();
    this.#watches = this.#watches.map((watch) => (watch.id === id ? { ...watch, ...patch } : watch));
    await this.#save();
  }

  async remove(id: string): Promise<boolean> {
    this.#assertLoaded();
    const before = this.#watches.length;
    this.#watches = this.#watches.filter((watch) => watch.id !== id);
    if (this.#watches.length !== before) await this.#save();
    return this.#watches.length !== before;
  }

  /** Writes are serialized so concurrent updates never race on the temp file. */
  #save(): Promise<void> {
    const snapshot: StoreFile = { version: 1, watches: [...this.#watches] };
    this.#tmpCounter += 1;
    const tmp = `${this.#file}.${process.pid}.${this.#tmpCounter}.tmp`;
    const write = async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    };
    this.#writes = this.#writes.then(write, write);
    return this.#writes;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("WatchStore.load() must run before use");
  }
}
