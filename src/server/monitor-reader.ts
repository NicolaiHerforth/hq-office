// THE MONITOR's reader: where every part of the monitor page's data is made, in a worker thread
// (monitor-reader-worker.ts) with a connection of its own to monitor.db, never on the server's thread. A part reads
// up to a few million rows, and SQLite reads them synchronously: on a busy machine whose file cache had been taken
// by other work, the page's questions held the server's thread for 30 s and more while SQLite waited on the disk,
// and the stall watch ended the server again and again (25 Nov). In the worker the same reads cost the page a wait
// and the rest of HQ Office nothing. The monitor's own tick still writes on the server's thread: it touches the
// newest minute only. SQLite's WAL mode lets the two connections read and write at once.
import { hostname } from "node:os";
import type { RangeKey } from "./monitor-page.ts";

// path is the database; at is the time that counts as now for a recording that is replayed, null for the clock.
export type Setup = { path: string; at: number | null; name: string };
export type Ask = { id: number; part: string; args: Record<string, unknown> };
// The parts a mark makes out of date start with this.
export const TIMELINE = "timeline:";

// The machine's name in the page's sentences: its own, as it calls itself.
const NAME = hostname().split(".")[0].replace(/^./, (c) => c.toUpperCase());

export type Reader = {
  now(size: { bytes: number; limit: number }): Promise<unknown>;
  range(key: RangeKey): Promise<unknown>;
  moment(key: RangeKey, t: number): Promise<unknown>;
  days(): Promise<unknown>;
  incidents(): Promise<unknown>;
  patterns(): Promise<unknown>;
  events(hours: number): Promise<unknown>;
  marks(hours: number): Promise<unknown>;
  growers(): Promise<unknown>;
  slots(): Promise<void>;
  // Drops what is kept of the timeline, once a mark is put down.
  marked(): void;
};

export function createReader(opts: { path: string; at: number | null }): Reader {
  const worker = new Worker(new URL("./monitor-reader-worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
  // The worker never keeps the server running by itself, and the server never waits on it to stop.
  worker.unref();
  worker.postMessage({ path: opts.path, at: opts.at, name: NAME } satisfies Setup);
  let next = 0;
  const waiting = new Map<number, { done: (value: unknown) => void; fail: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.error !== undefined) w.fail(new Error(e.data.error));
    else w.done(e.data.value);
  };
  // A worker that fell over fails what waits on it; the server goes on, and the page says it has no answer.
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.fail(new Error(`the monitor's reader stopped: ${e.message}`));
    waiting.clear();
  };
  const ask = <T>(part: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((done, fail) => {
      const id = ++next;
      waiting.set(id, { done: done as (value: unknown) => void, fail });
      worker.postMessage({ id, part, args } satisfies Ask);
    });
  return {
    now: (size) => ask("now", { size }),
    range: (key) => ask("range", { key }),
    moment: (key, t) => ask("moment", { key, t }),
    days: () => ask("days"),
    incidents: () => ask("incidents"),
    patterns: () => ask("patterns"),
    events: (hours) => ask("events", { hours }),
    marks: (hours) => ask("marks", { hours }),
    growers: () => ask("growers"),
    slots: () => ask("slots"),
    marked: () => void ask("forget", { prefix: TIMELINE }),
  };
}
