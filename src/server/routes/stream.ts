// Routes for stream. The router loads every file in this folder; see src/server/router.ts.
import { PING_MS, looks, pages, pushTo, refreshParts } from "../the-page-stream.ts";
import { pushCounts } from "../push.ts";
import { partBuilds } from "../state.ts";
import { json } from "../json.ts";
import { unplaced } from "../db-stamp.ts";
import { tableWrites } from "../db.ts";
import type { Page } from "../the-page-stream.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/stream", handle: () => {
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const page: Page = {
          sent: new Map(),
          send: (text) => {
            try {
              controller.enqueue(enc.encode(text));
            } catch {
              cleanup();
            }
          },
        };
        refreshParts();
        pushTo(page);
        pages.add(page);
        const ping = setInterval(() => page.send(`: ping\n\n`), PING_MS);
        cleanup = () => {
          pages.delete(page);
          clearInterval(ping);
        };
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  } },
  // Who bumped and touched since the server started, how often the stream looked and what it sent, and how often
  // each part of the state was built, and how many statements wrote to each table: where a push's cost comes from
  // (docs/footprint.md).
  { method: "GET", path: "/api/push", handle: () => json({ ...pushCounts(), pages: pages.size, looks: looks.looks, quiet: looks.quiet, pushes: looks.pushes, bytes: looks.bytes, partsSent: Object.fromEntries(looks.parts), partsBuilt: Object.fromEntries(partBuilds), writes: Object.fromEntries(tableWrites), writesNoTableNamed: unplaced.count }) },
];
export default routes;
