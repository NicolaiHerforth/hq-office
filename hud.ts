#!/usr/bin/env bun
// HQ's side of the command centre.
//   hud ask --lane L --title T [--body B] [--opt A --opt B] [--rec A] [--kind decision|action|info] [--link URL] [--due HH:MM]
//           [--secret NAME ...]   ask the owner for named secrets, filled in on the question card
//           [--item TEXT ...]     a checklist; an item naming a PR (#123) ticks itself when it merges, and the
//                                 question closes itself ("all done") when every item is done
// ask ledger: change an open question instead of withdrawing and reposting it
//   hud update ID [--title T] [--body B] [--opt A --opt B] [--rec A] [--link URL]   only the fields given
//   hud comment ID TEXT          a timestamped line under the question; information, not in the inbox
//   hud item ID N done|undo      tick or untick item N (from 1) by hand
//   hud item ID add TEXT         add an item to an open question
//   hud lane NAME [--title T] [--machine M] [--pane P] [--issue OPE-1] [--pr 123] [--phase running|waiting|parked|done] [--note N]
//                 [--role orchestrator|pm|builder|walker]   how its worker looks; --role "" clears it
//                 [--project "NAME=URL" ...]                its projects, replacing the list; a bare URL names itself;
//                                                           --project none clears them
//   hud rm-lane NAME
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
//   hud secret get NAME [--once] | <command>     the raw value to a pipe; refuses a terminal
//   hud secret rm NAME
//   hud secret list      names, who set them and when they expire; never values
// work board: one item per issue in flight; its state is derived from GitHub, the lane, and open asks
//   hud track ISSUE --lane L --pr N [--pr N...]   track (or add PRs to) a piece of work
//   hud done ISSUE                                close it by hand (merged or closed PRs close it on their own)
//   hud pause ISSUE REASON...  /  hud resume ISSUE deliberately on hold, so it is not called stalled
//   hud board [--json]                            stalled first; refreshes GitHub if the cache is over a minute old
//   hud guide            how HQ talks to the owner (through the HUD, never only in its terminal)
import { GUIDE } from "./src/hq-guide.ts";

const BASE = process.env.HUD_URL ?? "http://127.0.0.1:4747";

function parse(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) (flags[a.slice(2)] ??= []).push(argv[++i] ?? "");
    else rest.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  return { flags, rest, one };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-hud": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
      link: one("link"),
      due: dueAt(one("due")),
      secrets: flags.secret ?? [],
      items: flags.item,
    });
    console.log(`ask #${out.id}`);
    break;
  }
  case "update":
    await call("POST", `/api/asks/${rest[0]}/update`, { title: one("title"), body: one("body"), options: flags.opt, recommended: one("rec"), link: one("link") });
    console.log(`ask #${rest[0]} updated`);
    break;
  case "comment":
    await call("POST", `/api/asks/${rest[0]}/comment`, { text: rest.slice(1).join(" ") });
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
      note: one("note"),
      role: one("role"),
      projects: flags.project ? flags.project.filter((p) => p !== "none") : undefined,
    });
    console.log(`lane ${rest[0]}`);
    break;
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
    await call("POST", "/api/updates", { lane: one("lane"), title: one("title"), body: one("body") });
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
  default:
    console.log("usage: hud ask|update|comment|item|lane|rm-lane|withdraw|event|tell|say|inbox|ack|wait|state|sync|secret|track|done|pause|resume|board|guide");
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
    console.error("usage: hud secret set NAME --minutes N  (value on stdin) | get NAME [--once] | rm NAME | list");
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
      console.error(`secret ${m.name} set, expires ${new Date(m.expiresAt).toLocaleTimeString()}`);
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
    case "rm": {
      const { removed } = await call("POST", "/api/secrets/rm", { name });
      console.error(removed ? `secret ${name} removed` : `no secret ${name}`);
      break;
    }
    case "list": {
      const list = await call("GET", "/api/secrets");
      if (!list.length) console.log("no secrets");
      for (const s of list) {
        const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
        console.log(`${s.name}\tset by ${s.by} at ${new Date(s.setAt).toLocaleTimeString()}\texpires in ${Math.floor(left / 60)}m${String(left % 60).padStart(2, "0")}s`);
      }
      break;
    }
    default:
      usage();
  }
}
