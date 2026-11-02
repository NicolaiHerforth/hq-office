#!/bin/sh
# Subscription usage on one machine, read-only: what the agents last reported of their 5-hour and weekly windows.
# Claude: grazr's account files (grazr, a herdr plugin, keeps what Claude hands its status line after every message).
# Codex: the last rate_limits in its newest session log. Prints one JSON line of names, percentages and times; this
# line is all that leaves the machine. No email, no credential, no transcript text, and it never calls a provider.
# Runs locally or over ssh (`ssh host sh -s < sub-usage.sh`). macOS and Linux. No python3: says so and stops.
# python3 is looked up on the PATH it runs with (launchd's and ssh's both have /usr/bin), so a test can hide it.
PATH="${PATH:-/usr/bin:/bin}"
export PATH
none='{"v":1,"python":false,"claude":null,"codex":null}'
P=$(command -v python3) || { echo "$none"; exit 0; }
# On a Mac without the developer tools, /usr/bin/python3 is a stub that opens an installer dialog: never run it.
if [ "$(uname)" = "Darwin" ] && [ "$P" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then echo "$none"; exit 0; fi
"$P" - <<'PY' 2>/dev/null || echo "$none"
import glob, json, os, re
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
# grazr's kinds and Codex's window lengths (minutes), as the two windows the page shows.
CLAUDE_KINDS = {"session": "5h", "weekly_all": "week"}
CODEX_MINUTES = {300: "5h", 10080: "week"}
TAIL = 256 * 1024
EMAIL = re.compile(r"([^\s@]+)@\S+")


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def pct(v):
    return round(max(0.0, min(100.0, float(v))), 1)


def iso_ms(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return int((t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def label(value, fallback):
    # The owner names grazr's accounts; a name typed as an email address keeps only the part before the @.
    if not isinstance(value, str) or not value.strip():
        return fallback
    return EMAIL.sub(r"\1", value.strip())[:40]


def mtime_ms(path):
    try:
        return int(os.path.getmtime(path) * 1000)
    except OSError:
        return 0


def grazr_dir():
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state")
    for d in (os.path.join(state, "herdr", "plugins", "wazum.grazr"), os.path.join(HOME, ".grazr")):
        if os.path.isdir(os.path.join(d, "accounts")):
            return d
    return None


def active_claude_account():
    # Which login Claude uses on this machine: one id out of Claude's own file, nothing else read from it.
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    path = os.path.join(config, ".claude.json") if config else os.path.join(HOME, ".claude.json")
    try:
        with open(path) as handle:
            value = (json.load(handle).get("oauthAccount") or {}).get("accountUuid")
        return str(value).lower() if value else None
    except Exception:
        return None


def claude():
    d = grazr_dir()
    if d is None:
        return None
    active = active_claude_account()
    out = []
    for path in sorted(glob.glob(os.path.join(d, "accounts", "*.json"))):
        key = os.path.basename(path)[: -len(".json")].lower()
        if not re.fullmatch(r"[0-9a-f-]{36}", key):
            continue
        try:
            with open(path) as handle:
                stored = json.load(handle)
        except Exception:
            continue
        if not isinstance(stored, dict):
            continue
        windows = []
        for entry in stored.get("snapshot") or []:
            if not isinstance(entry, dict):
                continue
            w = CLAUDE_KINDS.get(entry.get("kind"))
            if w and num(entry.get("remaining")):
                windows.append({"w": w, "left": pct(entry["remaining"]), "resets": iso_ms(entry.get("resets_at"))})
        out.append({"key": key, "name": label(stored.get("name"), "CLAUDE"), "active": key == active, "at": mtime_ms(path), "windows": windows})
    return out


def tail_lines(path):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - TAIL))
            chunk = handle.read()
    except OSError:
        return []
    lines = chunk.decode("utf-8", "replace").split("\n")
    return lines[1:] if size > TAIL else lines


def codex_reading(path):
    # The newest rate_limits object per limit in this log, read from its end. Only that object is looked at.
    found = {}
    for line in reversed(tail_lines(path)):
        if '"rate_limits"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        limits = payload.get("rate_limits") or event.get("rate_limits")
        if not isinstance(limits, dict):
            continue
        limit = limits.get("limit_id") if isinstance(limits.get("limit_id"), str) else "codex"
        limit = re.sub(r"[^a-z0-9_-]", "", limit.lower())[:32] or "codex"
        if limit in found:
            continue
        at = iso_ms(event.get("timestamp")) or mtime_ms(path)
        windows = []
        for side in ("primary", "secondary"):
            w = limits.get(side)
            if not isinstance(w, dict) or not num(w.get("used_percent")):
                continue
            kind = CODEX_MINUTES.get(w.get("window_minutes"))
            if not kind:
                continue
            if num(w.get("resets_at")):
                resets = int(w["resets_at"] * 1000)
            elif num(w.get("resets_in_seconds")):
                resets = at + int(w["resets_in_seconds"] * 1000)
            else:
                resets = None
            windows.append({"w": kind, "left": pct(100 - w["used_percent"]), "resets": resets})
        plan = limits.get("plan_type")
        plan = re.sub(r"[^a-z0-9_ -]", "", plan.lower())[:20] if isinstance(plan, str) else None
        found[limit] = {"key": limit, "name": "CODEX", "plan": plan or None, "at": at, "windows": windows}
    return list(found.values())


def codex():
    home = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    root = os.path.join(home, "sessions")
    if not os.path.isdir(root):
        return None
    # The last week of day folders, newest log first: the first log with a reading is the latest reading.
    days = sorted(glob.glob(os.path.join(root, "[0-9]" * 4, "[0-9]" * 2, "[0-9]" * 2)))[-7:]
    logs = sorted((f for d in days for f in glob.glob(os.path.join(d, "*.jsonl"))), key=mtime_ms, reverse=True)
    for path in logs[:5]:
        reading = codex_reading(path)
        if reading:
            return reading
    return []


def safe(fn):
    try:
        return fn()
    except Exception:
        return None


print(json.dumps({"v": 1, "python": True, "claude": safe(claude), "codex": safe(codex)}, separators=(",", ":")))
PY
