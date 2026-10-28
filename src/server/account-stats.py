# Accounts on this machine: what each Claude and Codex account has left, as names and percentages only.
# Run here, or over ssh as `python3 -I -` (accounts.ts). It prints one JSON object.
#
# It never opens a credential. Claude's side is grazr's (a herdr plugin that rotates Claude accounts): its account
# files hold a name and the last usage reading, and the active login is the one account id in ~/.claude.json, read
# by that key alone and never printed. Codex's side is one Codex home per account (~/.codex, ~/.codex-<name>): a
# home is logged in when its auth.json exists (never read), and usage comes from the rate limits each session
# records in its own log.
import glob
import json
import os
import shlex

HOME = os.path.expanduser("~")
GRAZR_KEYS = ("ACCOUNTS", "REMAINING_SESSION", "REMAINING_WEEKLY", "ENABLED", "DRY_RUN")


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def grazr_config(path):
    config = {}
    try:
        with open(path) as handle:
            for line in handle:
                parts = shlex.split(line, comments=True)
                if parts and "=" in parts[0]:
                    key, _, value = parts[0].partition("=")
                    if key in GRAZR_KEYS:
                        config[key] = value
    except (OSError, ValueError):
        pass
    return config


def windows(snapshot):
    """The lowest reading per window ('session' is five hours, 'weekly' the week), with when it resets."""
    best = {}
    for entry in snapshot if isinstance(snapshot, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("remaining"), (int, float)):
            continue
        group = entry.get("group")
        if group not in best or entry["remaining"] < best[group]["left"]:
            best[group] = {"left": entry["remaining"], "resets_at": entry.get("resets_at")}
    return best


def claude():
    state = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state"), "herdr", "plugins", "wazum.grazr")
    installed = bool(glob.glob(os.path.join(HOME, ".config", "herdr", "plugins", "github", "wazum.grazr-*")))
    active = ((read_json(os.path.join(HOME, ".claude.json")) or {}).get("oauthAccount") or {}).get("accountUuid")
    accounts = []
    for path in sorted(glob.glob(os.path.join(state, "accounts", "*.json"))):
        stored = read_json(path)
        if not isinstance(stored, dict):
            continue
        identifier = os.path.basename(path)[: -len(".json")]
        accounts.append({
            "name": str(stored.get("name") or "unnamed"),
            "active": bool(active) and identifier.lower() == str(active).lower(),
            "windows": windows(stored.get("snapshot")),
        })
    status_line = (read_json(os.path.join(HOME, ".claude", "settings.json")) or {}).get("statusLine")
    log = []
    try:
        with open(os.path.join(state, "grazr.log")) as handle:
            log = [line.rstrip("\n") for line in handle.readlines()[-6:]]
    except OSError:
        pass
    return {
        "grazr": installed,
        "logged_in": bool(active),
        "active_enrolled": any(a["active"] for a in accounts),
        "accounts": accounts,
        "config": grazr_config(os.path.join(HOME, ".config", "herdr", "plugins", "config", "wazum.grazr", "config.env")),
        "status_line": "grazr" in json.dumps(status_line) if status_line else False,
        "log": log,
    }


def last_rate_limits(path):
    """The newest rate-limit reading in one session log: its time and each window's percent used."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 262144))
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if '"rate_limits"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        limits = (event.get("payload") or {}).get("rate_limits") or {}
        found = []
        for key in ("primary", "secondary"):
            w = limits.get(key)
            if isinstance(w, dict) and isinstance(w.get("used_percent"), (int, float)):
                found.append({"minutes": w.get("window_minutes"), "used": w["used_percent"], "resets_at": w.get("resets_at")})
        if found:
            return {"at": event.get("timestamp"), "windows": found}
    return None


def codex():
    homes = []
    for path in [os.path.join(HOME, ".codex")] + sorted(glob.glob(os.path.join(HOME, ".codex-*"))):
        # A home holds a login or sessions; ~/.codex-cli, an npm install, is not one.
        if os.path.islink(path) or not any(os.path.exists(os.path.join(path, f)) for f in ("auth.json", "sessions", "config.toml")):
            continue
        name = "codex" if os.path.basename(path) == ".codex" else os.path.basename(path)[len(".codex-"):]
        linked = os.path.islink(os.path.join(path, "sessions"))
        sessions = os.path.realpath(os.path.join(path, "sessions"))
        homes.append({"name": name, "logged_in": os.path.exists(os.path.join(path, "auth.json")), "sessions": sessions, "linked": linked})
    # A second home links to the first one's sessions, so `codex resume` finds them from either. A session log does
    # not say which account wrote it, so a shared folder's readings go to the home that owns it; a home whose
    # sessions are linked shows a reading only once something records which panes run on it.
    readings = {}
    for sessions in {h["sessions"] for h in homes}:
        files = sorted(glob.glob(os.path.join(sessions, "*", "*", "*", "*.jsonl")), key=os.path.getmtime, reverse=True)[:12]
        newest = None
        for f in files:
            reading = last_rate_limits(f)
            if reading and (newest is None or str(reading["at"]) > str(newest["at"])):
                newest = reading
        readings[sessions] = newest
    shared = {}
    for h in homes:
        shared.setdefault(h["sessions"], []).append(h["name"])
    return [
        {"name": h["name"], "logged_in": h["logged_in"], "reading": None if h["linked"] else readings.get(h["sessions"]), "shares_sessions_with": [n for n in shared[h["sessions"]] if n != h["name"]]}
        for h in homes
    ]


print(json.dumps({"claude": claude(), "codex": codex()}))
