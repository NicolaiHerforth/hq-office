#!/usr/bin/env bun
// HQ's side of the command centre.
//   hud ask --lane L --title T [--body B] [--opt A --opt B --rec A] [--kind decision|action|info] [--link URL] [--due HH:MM]
//           a decision with --opt needs --rec (your pick; the why goes in --body); no options (--kind action|info) needs none
//           [--room SLUG]         the room (project) this question is about; the project counts it. Never guessed from the lane
//           [--from LANE]         the lane that handed this question in (shown on the card as handed in by it)
//           [--urgent]            sort it to the top of the desk, marked URGENT (it is counted: hud urgent)
//           [--secret NAME ...]   ask the owner for named secrets, filled in on the question card
//           [--item TEXT ...]     a checklist; an item naming a PR (#123) ticks itself when it merges, and the
//                                 question closes itself ("all done") when every item is done
// ask ledger: change an open question instead of withdrawing and reposting it
//   hud update ID [--title T] [--body B] [--opt A --opt B] [--rec A] [--link URL] [--lane L] [--room SLUG]   only the fields given;
//                                --lane L moves it to lane L, --lane hq (or "") takes it off every lane;
//                                --room SLUG names its room, --room "" clears it
//   hud comment ID TEXT [--as LANE]   a timestamped line under the question; information, not in the inbox. A lane
//                                answering the owner's comment writes it with --as LANE
//   hud item ID N done|undo      tick or untick item N (from 1) by hand
//   hud item ID add TEXT         add an item to an open question
//   hud lane NAME [--title T] [--machine M] [--pane P] [--issue OPE-1] [--pr 123] [--phase running|waiting|parked|done] [--note N]
//           [--parent OTHER]      the lane it reports to; --parent hq (or "") puts it straight under HQ
//           [--level NAME|auto]   its level (one of the owner's level names) over the one the tree gives; auto: the tree's
//   hud rm-lane NAME     its reports move up to the lane it reported to (or HQ)
//   hud tree [--json]    the lanes under HQ, each with its level name and status
//   hud withdraw ID [--reason R]
//   hud event [--lane L] TEXT
//   hud tell --title T [--lane L] [--body B]   an update for the owner: information, no reply asked for
//                                              (hud say is the same command)
//   hud inbox            answers and notes HQ has not acted on
//   hud ack a:ID | n:ID  mark an answer or note as acted on
//   hud wait             block until the owner answers or writes (exits with the inbox)
//   hud state            the board as JSON
//   hud sync             refresh herdr status now
//   hud secret set NAME --minutes N [--by WHO]   the value comes from stdin, never from an argument
//   hud secret get NAME [--once] | <command>     the raw value to a pipe; refuses a terminal; says if it was lost
//   hud secret rm NAME
//   hud secret redact NAME  replace the value wherever it was typed and stored (answers, notes, updates) with [secret NAME]
//   hud secret list      names, who set them and when they expire, and LOST ones (lost in a restart); never values
// the queue: what a lane sends HQ. It waits until HQ reads it; only --urgent also types a line into HQ's pane.
//   hud request --lane NAME [--kind READY|BLOCK|QUESTION|DONE|NOTE] [--urgent] [--lead NAME] [--pr N]
//               [--default "what I will do" --by HH:MM|+30m] ("text" | --file PATH)
//                                   files it and returns at once. NAME is the lane's herdr agent name; the kind defaults to NOTE;
//                                   --file reads the text from a file (a long message typed on the line gets truncated);
//                                   --lead names who must answer (default: the orchestration registry, else HQ); --default/--by
//                                   only on BLOCK or QUESTION: when --by comes the lane goes ahead and the item is marked defaulted
//   hud req next [--lead NAME]      the first open item: urgent first, then oldest (nothing when the queue is empty)
//   hud req list [--lead NAME] [--all] [--json]   open items in that order (--all: closed and defaulted too)
//   hud req answer ID "text"        types the answer into the lane's pane and closes the item; if it does not
//                                   reach the pane the item stays open and this exits 1
//   hud req close ID "why"         closes an item whose lane is gone (no live agent), with the reason; refused for a live lane
//   hud urgent ID --by WHO|--lane NAME      push an open item (desk or queue) to the top of its list
//   hud urgent [--since 7d]         the urgent uses in that window, by who and by recipient
// work board: one item per issue in flight; its state is derived from GitHub, the lane, and open asks
//   hud track ISSUE --lane L --pr N [--pr N...]   track (or add PRs to) a piece of work
//   hud done ISSUE                                close it by hand (merged or closed PRs close it on their own)
//   hud pause ISSUE REASON...  /  hud resume ISSUE deliberately on hold, so it is not called stalled
//   hud board [--json]                            blocked on a prompt, then stalled, first; refreshes GitHub if the cache is over a minute old
//   hud guide            how HQ talks to the owner (through the HUD, never only in its terminal)
// conference rooms: one per piece of work, where the owner talks straight to the lane that owns it (see roomCmd below)
//   hud room create|path|brief|artifact|say|read|list|archive ...   `hud room` prints the usage
import { GUIDE } from "./src/hq-guide.ts";
import { treeText } from "./src/lane-tree.ts";
import { atText, expiresText } from "./src/client/secrets/expiry.js";
import { restartTime } from "./src/server/secrets.ts";

const BASE = process.env.HUD_URL ?? "http://127.0.0.1:4747";

const SWITCHES = new Set(["urgent", "all", "json"]);

function parse(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A switch takes no value; every other flag takes the next word, even one that begins with -- (--opt "--force push").
    if (a.startsWith("--")) (flags[a.slice(2)] ??= []).push(SWITCHES.has(a.slice(2)) ? "" : (argv[++i] ?? ""));
    else rest.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  return { flags, rest, one };
}

async function call(method: string, path: string, body?: unknown) {
  // A builder's sandbox can refuse the loopback connection (EPERM); say so in one line instead of a stack trace,
  // so the builder ends with its report in its own pane, where the hand-back relay reads it (24 Oct 2026).
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-hud": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e: unknown) => {
    console.error(`HUD unreachable at ${BASE} (${e instanceof Error ? e.message : String(e)}). End with your full report in your own pane; the relay sends it to your lead.`);
    process.exit(2);
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(data.error ?? res.statusText);
    process.exit(1);
  }
  return data;
}

function dueAt(hhmm?: string) {
  if (!hhmm) return undefined;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m ?? 0, 0, 0);
  return d.getTime();
}

// "HH:MM" is its next occurrence, "+30m" or "+2h" is that long from now, anything else is a date Bun can parse.
function byAt(raw?: string) {
  if (!raw) return undefined;
  const rel = raw.match(/^\+(\d+)([mh])$/);
  if (rel) return Date.now() + Number(rel[1]) * (rel[2] === "h" ? 3600_000 : 60_000);
  const clock = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const d = new Date();
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    console.error(`--by: not a time: ${raw} (use HH:MM, +30m or +2h)`);
    process.exit(2);
  }
  return t;
}

function age(ms: number) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function showRequest(r: any, full: boolean) {
  const head = `#${r.id} ${r.kind}${r.urgent_at ? " URGENT" : ""} ${r.lane ?? "owner"}${r.pr ? ` PR #${r.pr}` : ""} ${r.status === "open" ? `open ${age(r.created_at)}` : `${r.status} ${age(r.answered_at ?? r.defaulted_at ?? r.created_at)} ago`} lead ${r.lead}`;
  if (!full) return `${head}: ${r.text.replace(/\s+/g, " ").slice(0, 100)}`;
  const lines = [head, r.text];
  if (r.default_by) lines.push(`default: ${r.default_action} (${r.status === "open" ? `at ${new Date(r.default_by).toLocaleTimeString()}` : "came due"})`);
  if (r.last_error) lines.push(`last delivery failed: ${r.last_error}`);
  lines.push(`answer with: hud req answer ${r.id} "<text>"`);
  return lines.join("\n");
}

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest, one } = parse(argv);

switch (cmd) {
  case "ask": {
    const out = await call("POST", flags.item ? "/api/ledger/asks" : "/api/asks", {
      lane: one("lane"),
      kind: one("kind"),
      title: one("title"),
      body: one("body"),
      options: flags.opt ?? [],
      recommended: one("rec"),
      from: one("from"),
      room: one("room"),
      link: one("link"),
      due: dueAt(one("due")),
      secrets: flags.secret ?? [],
      items: flags.item,
      urgent: "urgent" in flags,
    });
    console.log(`ask #${out.id}`);
    break;
  }
  case "update":
    await call("POST", `/api/asks/${rest[0]}/update`, { title: one("title"), body: one("body"), options: flags.opt, recommended: one("rec"), link: one("link"), lane: one("lane"), room: one("room") });
    console.log(`ask #${rest[0]} updated`);
    break;
  case "comment":
    await call("POST", `/api/asks/${rest[0]}/comment`, { text: rest.slice(1).join(" "), as: one("as") });
    break;
  case "item": {
    const [id, what, ...words] = rest;
    if (what === "add") console.log(`item ${(await call("POST", `/api/asks/${id}/items`, { text: words.join(" ") })).n}`);
    else if (/^\d+$/.test(what ?? "") && ["done", "undo"].includes(words[0])) await call("POST", `/api/asks/${id}/items/${what}`, { done: words[0] === "done" });
    else {
      console.error("usage: hud item ID N done|undo  |  hud item ID add TEXT");
      process.exit(2);
    }
    break;
  }
  case "lane":
    await call("POST", "/api/lanes", {
      name: rest[0],
      title: one("title"),
      machine: one("machine"),
      pane: one("pane"),
      issue: one("issue"),
      pr: flags.pr?.join(","),
      phase: one("phase"),
      level: one("level"),
      note: one("note"),
      parent: one("parent"),
    });
    console.log(`lane ${rest[0]}`);
    break;
  case "tree": {
    const { lanes } = await call("GET", "/api/state");
    const view = lanes.map((l: any) => ({ name: l.name, parent: l.parent, depth: l.depth, level: l.level, status: l.status, path: l.path }));
    console.log("json" in flags ? JSON.stringify(view, null, 2) : treeText(view));
    break;
  }
  case "rm-lane":
    await call("POST", "/api/lanes/delete", { name: rest[0] });
    break;
  case "withdraw":
    await call("POST", `/api/asks/${rest[0]}/withdraw`, { reason: one("reason") });
    break;
  case "event":
    await call("POST", "/api/events", { lane: one("lane"), text: rest.join(" ") });
    break;
  case "tell":
  case "say":
    // The text may come as --body or as the trailing words: on 24 Oct 2026 every HQ tell passed it positionally,
    // it was dropped, and the owner saw titles only.
    await call("POST", "/api/updates", { lane: one("lane"), title: one("title"), body: one("body") ?? (rest.join(" ") || undefined) });
    break;
  case "inbox":
    console.log(JSON.stringify(await call("GET", "/api/inbox"), null, 2));
    break;
  case "ack":
    for (const ref of rest) {
      const [kind, id] = ref.split(":");
      await call("POST", `/api/${kind === "n" ? "notes" : "asks"}/${id}/ack`, {});
    }
    break;
  case "wait": {
    for (;;) {
      const box = await call("GET", "/api/wait?s=240");
      if (box.answers.length || box.notes.length) {
        console.log(JSON.stringify(box, null, 2));
        break;
      }
    }
    break;
  }
  case "state":
    console.log(JSON.stringify(await call("GET", "/api/state"), null, 2));
    break;
  case "sync":
    await call("POST", "/api/sync", {});
    break;
  case "secret":
    await secret(argv);
    break;
  case "request": {
    const file = one("file");
    if (file !== undefined && !file) {
      console.error("--file needs a path");
      process.exit(2);
    }
    const text = file ? await Bun.file(file).text().catch((e: Error) => (console.error(`--file: ${e.message}`), process.exit(2))) : rest.join(" ");
    const out = await call("POST", "/api/requests", { kind: one("kind"), lane: one("lane"), lead: one("lead"), pr: one("pr"), default: one("default"), by: byAt(one("by")), urgent: "urgent" in flags, text });
    if (out.warning) console.error(`warning: ${out.warning}`);
    console.log(`request #${out.id}`);
    break;
  }
  case "req": {
    const [verb, ...more] = rest;
    const query = (params: Record<string, string> = {}) => {
      const lead = one("lead")?.trim();
      const q = new URLSearchParams(lead ? { ...params, lead } : params).toString();
      return q ? `?${q}` : "";
    };
    if (verb === "next") {
      const r = await call("GET", `/api/requests/next${query()}`);
      console.log(r ? showRequest(r, true) : "no open requests");
    } else if (verb === "list") {
      const list = await call("GET", `/api/requests${query("all" in flags ? { all: "1" } : {})}`);
      if ("json" in flags) console.log(JSON.stringify(list, null, 2));
      else console.log(list.length ? list.map((r: any) => showRequest(r, false)).join("\n") : "no open requests");
    } else if (verb === "answer" && more[0] && more.length > 1) {
      const out = await call("POST", `/api/requests/${more[0]}/answer`, { text: more.slice(1).join(" ") });
      console.log(out.lane ? `request #${out.id} answered: delivered to ${out.lane} and closed` : `request #${out.id} answered: posted to the owner as an update (FROM HQ and MESSAGES) and closed`);
    } else if (verb === "close" && more[0] && more.length > 1) {
      const out = await call("POST", `/api/requests/${more[0]}/close`, { reason: more.slice(1).join(" ") });
      console.log(out.lane ? `request #${out.id} closed without delivery: ${out.lane} is gone` : `the owner's note #${out.id} closed with no reply`);
    } else {
      console.error('usage: hud req next [--lead NAME] | list [--lead NAME] [--all] [--json] | answer ID "text" | close ID "why"');
      process.exit(2);
    }
    break;
  }
  case "urgent":
    if (/^\d+$/.test(rest[0] ?? "")) {
      // Every use is counted by who made it, so say who: a lane its name, HQ --by hq.
      const by = (one("by") || one("lane"))?.trim();
      if (!by) {
        console.error("usage: hud urgent ID --by WHO (or --lane NAME): the urgent report counts uses by who made them");
        process.exit(2);
      }
      await call("POST", `/api/asks/${rest[0]}/urgent`, { by });
      console.log(`#${rest[0]} is urgent`);
    } else {
      const since = one("since") || "7d";
      const rows = await call("GET", `/api/urgent?since=${encodeURIComponent(since)}`);
      if (!rows.length) console.log(`no urgent uses in the last ${since}`);
      else {
        console.log(`urgent uses in the last ${since}: ${rows.reduce((n: number, r: any) => n + r.n, 0)}`);
        for (const r of rows) console.log(`${String(r.n).padStart(4)}  ${r.by} -> ${r.recipient}`);
      }
    }
    break;
  // ---- work board ----
  case "track":
    await call("POST", "/api/board/track", { issue: rest[0], lane: one("lane"), prs: flags.pr ?? [] });
    console.log(`tracking ${rest[0]}`);
    break;
  case "done":
    await call("POST", "/api/board/done", { issue: rest[0] });
    break;
  case "pause":
    await call("POST", "/api/board/pause", { issue: rest[0], reason: one("reason") ?? rest.slice(1).join(" ") });
    break;
  case "resume":
    await call("POST", "/api/board/resume", { issue: rest[0] });
    break;
  case "board": {
    if ("json" in flags) {
      console.log(JSON.stringify(await call("GET", "/api/board?refresh=1"), null, 2));
      break;
    }
    const res = await fetch(`${BASE}/api/board?refresh=1&format=text`);
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
    process.stdout.write(await res.text());
    break;
  }
  case "guide":
    console.log(GUIDE);
    break;
  case "room":
    await roomCmd(argv);
    break;
  default:
    console.log("usage: hud ask|update|comment|item|lane|rm-lane|tree|withdraw|event|tell|say|inbox|ack|wait|state|sync|secret|request|req|urgent|track|done|pause|resume|board|room|guide");
    console.log("HQ: run `hud guide` for how to reach the owner (through the HUD, never only in your terminal).");
}

// ---- secrets: the value only ever travels through stdin, the request body and stdout ----

async function readValue(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  // Typed at a terminal: no echo, so the value never shows on screen or in a scrollback.
  process.stderr.write("value (hidden): ");
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stderr.write("\n");
  }
}

async function secret(args: string[]) {
  const once = args.includes("--once");
  const { rest, one } = parse(args.filter((a) => a !== "--once"));
  const [verb, name, ...extra] = rest;
  const usage = () => {
    console.error("usage: hud secret set NAME --minutes N  (value on stdin) | get NAME [--once] | rm NAME | redact NAME | list");
    process.exit(2);
  };
  if (verb !== "list" && !name) usage();
  switch (verb) {
    case "set": {
      if (extra.length || one("value") !== undefined) {
        console.error("the value is read from stdin, never from an argument: <command> | hud secret set NAME --minutes N");
        process.exit(2);
      }
      const minutes = Number(one("minutes"));
      if (!(minutes > 0)) usage();
      const value = await readValue();
      const m = await call("POST", "/api/secrets", { name, value, minutes, by: one("by") ?? "hq" });
      console.error(`secret ${m.name} set, ${expiresText(m.expiresAt)}`);
      break;
    }
    case "get": {
      // Checked before the request: a value printed to a terminal lands in a transcript.
      if (process.stdout.isTTY) {
        console.error(`refusing to print secret ${name} to a terminal. Pipe it instead: hud secret get ${name} | <command>`);
        process.exit(2);
      }
      const { value } = await call("POST", "/api/secrets/get", { name, once });
      process.stdout.write(value);
      break;
    }
    case "redact": {
      // The server replaces the value wherever it is stored with [secret NAME]; the value never comes through here.
      const { rows, tables } = await call("POST", "/api/secrets/redact", { name });
      console.log(rows ? `redacted ${name} from ${rows} stored ${rows === 1 ? "row" : "rows"}: ${Object.entries(tables).map(([k, n]) => `${k} ${n}`).join(", ")}` : `${name} is not stored anywhere`);
      break;
    }
    case "rm": {
      const { removed } = await call("POST", "/api/secrets/rm", { name });
      console.error(removed ? `secret ${name} removed` : `no secret ${name}`);
      break;
    }
    case "list": {
      const list = await call("GET", "/api/secrets");
      if (!list.length) console.log("no secrets");
      // A lost one is a name the server knew but lost its value in a restart: it has to be set again.
      for (const s of list) {
        const set = `set by ${s.by} ${atText(s.setAt)}`;
        if (s.lostAt) console.log(`${s.name}\tLOST (lost in a restart at ${restartTime(s.lostAt)}, set it again)\t${set}`);
        else console.log(`${s.name}\t${set}\t${expiresText(s.expiresAt)}`);
      }
      break;
    }
    default:
      usage();
  }
}

// ---- conference rooms (hud room ...): the brief, the shelf and the thread of one piece of work ----

// (Function declarations, not constants: the switch above runs before any constant down here exists.)
function roomUsage() {
  return `usage:
  hud room create SLUG --title T --owner LANE [--member L ...] [--issue X ...] [--pr N ...]   (again: change or reopen it)
  hud room path SLUG                                 the room's folder: files/ is shared, and what is saved there shows on the shelf
  hud room brief SLUG --body B [--as LANE]           the pinned brief, replaced as a whole (or from stdin)
  hud room brief SLUG                                 prints the brief (nothing given: never writes); --clear clears it
  hud room artifact SLUG --title T (--url U | --file PATH) [--kind claude-artifact|link|image|file] [--as LANE]
  hud room say SLUG TEXT [--as LANE] [--reply ID]    write in the thread (as the owning lane unless --as)
  hud room read SLUG [--since ID] [--wait] [--json]  the owner's messages; --wait blocks until a new one
  hud room list [--all] [--json]
  hud room archive SLUG`;
}

// Text from an argument, else from stdin when it is piped.
// Text from --body, else piped in. A stdin that is open but says nothing (a shell or an agent's tool that never closes
// it) would wait forever: with no first bytes within a second it counts as nothing given.
async function textArg(given: string | undefined) {
  if (given !== undefined) return given;
  if (process.stdin.isTTY) return "";
  const reader = Bun.stdin.stream().getReader();
  const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => null)]);
  if (!first || first.done) {
    reader.releaseLock();
    return "";
  }
  const chunks = [first.value];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  return new TextDecoder().decode(Buffer.concat(chunks)).replace(/\r?\n$/, "");
}

function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`;
}

async function roomCmd(args: string[]) {
  const bools = new Set(args.filter((a) => ["--json", "--wait", "--all", "--clear"].includes(a)));
  const { flags: f, rest: r, one: o } = parse(args.filter((a) => !bools.has(a)));
  const [verb, slugRaw, ...words] = r;
  const slug = (slugRaw ?? "").toLowerCase();
  const path = `/api/rooms/${encodeURIComponent(slug)}`;
  const usage = () => {
    console.error(roomUsage());
    process.exit(2);
  };
  if (verb !== "list" && !slug) usage();
  switch (verb) {
    case "create": {
      const out = await call("POST", "/api/rooms", { slug, title: o("title"), owner: o("owner"), members: f.member ?? [], issues: f.issue ?? [], prs: f.pr ?? [] });
      console.log(`room ${out.slug} ${out.created ? "created" : "updated"}`);
      console.log(`folder ${out.folder} (files/ is shared; anything saved there shows on the shelf)`);
      break;
    }
    case "path":
      console.log((await call("GET", path)).folder);
      break;
    case "brief": {
      // Writes only what it is given: --body, or text piped in. Nothing given (no --body, nothing on stdin) prints
      // the brief; an empty brief is never a way to clear one by accident, only --clear clears it.
      if (bools.has("--clear")) {
        await call("POST", `${path}/brief`, { body: "", clear: true, as: o("as") });
        console.log(`brief of ${slug} cleared`);
        break;
      }
      const body = await textArg(o("body"));
      if (!body.trim()) {
        if (o("body") !== undefined) {
          console.error(`an empty --body would clear the brief of ${slug}; to clear it, use: hud room brief ${slug} --clear`);
          process.exit(2);
        }
        const v = await call("GET", path);
        console.log(v.brief ?? `(${slug} has no brief yet: hud room brief ${slug} --body B, or pipe it in)`);
        break;
      }
      await call("POST", `${path}/brief`, { body, as: o("as") });
      console.log(`brief of ${slug} set`);
      break;
    }
    case "artifact": {
      const file = o("file");
      if (!!file === !!o("url")) usage();
      if (file) {
        const blob = Bun.file(file);
        if (!(await blob.exists())) {
          console.error(`no file ${file}`);
          process.exit(1);
        }
        const name = file.split("/").pop()!;
        const q = new URLSearchParams({ name, title: o("title") ?? name, ...(o("kind") ? { kind: o("kind")! } : {}), ...(o("as") ? { as: o("as")! } : {}) });
        const res = await fetch(`${BASE}${path}/files?${q}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream", "x-hud": "1" }, body: blob });
        const out = await res.json();
        if (!res.ok) {
          console.error(out.error ?? res.statusText);
          process.exit(1);
        }
        console.log(`artifact #${out.id} (${out.kind}) on ${slug}: ${BASE}${out.url}`);
        console.log(`file ${out.path}`);
      } else {
        const out = await call("POST", `${path}/artifacts`, { title: o("title"), url: o("url"), kind: o("kind"), as: o("as") });
        console.log(`artifact #${out.id} on ${slug}`);
      }
      break;
    }
    case "say": {
      const out = await call("POST", `${path}/say`, { text: await textArg(words.length ? words.join(" ") : undefined), as: o("as"), reply: o("reply") });
      console.log(`message #${out.id} in ${slug}`);
      break;
    }
    case "read": {
      let since = o("since");
      for (;;) {
        const q = new URLSearchParams({ ...(since ? { since } : {}), ...(bools.has("--wait") ? { wait: "240" } : {}) });
        const out = await call("GET", `${path}/read?${q}`);
        if (bools.has("--wait") && !out.messages.length) {
          since = String(out.since);
          continue;
        }
        if (bools.has("--json")) console.log(JSON.stringify(out, null, 2));
        else {
          if (!out.messages.length) console.log(`no messages from the owner in ${slug} after #${out.since}`);
          for (const m of out.messages) console.log(`#${m.id} ${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} owner -> ${m.to}${m.reply ? ` (re #${m.reply})` : ""}: ${m.text}`);
          console.log(`next: hud room read ${slug} --since ${out.last}${bools.has("--wait") ? " --wait" : ""}`);
        }
        break;
      }
      break;
    }
    case "list": {
      const rooms = await call("GET", `/api/rooms${bools.has("--all") ? "?all=1" : ""}`);
      if (bools.has("--json")) {
        console.log(JSON.stringify(rooms, null, 2));
        break;
      }
      if (!rooms.length) console.log("no rooms yet: hud room create SLUG --title T --owner LANE");
      for (const x of rooms) {
        const work = [...x.issues, ...x.prs.map((p: string) => `#${p.split("#").pop()}`)].join(" ");
        console.log(`${x.slug}${x.archivedAt ? " (archived)" : ""}  "${x.title}"  owner ${x.owner}${x.members.length ? `  members ${x.members.join(", ")}` : ""}${work ? `  work ${work}` : ""}  ${x.artifacts} artifacts  last ${ago(x.lastAt)}${x.unread ? `  ${x.unread} unread by the owner` : ""}`);
      }
      break;
    }
    case "archive":
      await call("POST", `${path}/archive`, {});
      console.log(`room ${slug} archived`);
      break;
    default:
      usage();
  }
}
