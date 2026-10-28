# Accounts on this machine: what each Claude and Codex account has left, as names and percentages only.
# Run here, or over ssh as `python3 -I -` (accounts.ts). It prints one JSON object.
#
# It never opens a credential. Claude's side is one home per account (~/.claude, ~/.claude-<name>): a home is logged
# in when its credentials file or its keychain item exists (asked by name and exit code, never read), and usage is
# what the lane status line recorded for it. Codex's side is one Codex home per account (~/.codex, ~/.codex-<name>):
# a home is logged in when its auth.json exists (never read), and usage comes from the rate limits each session
# records in its own log.
import glob
import hashlib
import json
import os
import subprocess

HOME = os.path.expanduser("~")
SECURITY = os.environ.get("HQ_SECURITY_BIN", "security")


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def home_login(directory, name):
    """Whether a Claude home holds a login, by name only: its credentials file exists, or its keychain item does
    (asked by exit code; the item's attributes and secret go nowhere)."""
    if os.path.exists(os.path.join(directory, ".credentials.json")):
        return True
    # The default home's item is plain; another home's carries the first 8 hex digits of the sha256 of its path.
    service = "Claude Code-credentials" if name == "default" else "Claude Code-credentials-" + hashlib.sha256(directory.encode()).hexdigest()[:8]
    try:
        return subprocess.run([SECURITY, "find-generic-password", "-s", service], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def usage(name):
    """What the lane status line (claude-statusline.py) last recorded for this account: each window's percent left."""
    state = os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state")
    stored = read_json(os.path.join(state, "hq-office", "claude-usage", name + ".json"))
    limits = (stored or {}).get("rate_limits") if isinstance(stored, dict) else None
    found = {}
    for group, key in (("session", "five_hour"), ("weekly", "seven_day")):
        w = (limits or {}).get(key) if isinstance(limits, dict) else None
        used = (w or {}).get("used_percentage") if isinstance(w, dict) else None
        if isinstance(used, (int, float)):
            found[group] = {"left": max(0, 100 - used), "resets_at": w.get("resets_at")}
    return found


def claude():
    """One Claude home per account: ~/.claude is `default`, ~/.claude-<name> is <name>."""
    homes = []
    for path in [os.path.join(HOME, ".claude")] + sorted(glob.glob(os.path.join(HOME, ".claude-*"))):
        name = "default" if os.path.basename(path) == ".claude" else os.path.basename(path)[len(".claude-"):]
        # The default home is always one. Another is a folder with a login or a config file; other ~/.claude-* are not.
        if name != "default" and (os.path.islink(path) or not any(os.path.exists(os.path.join(path, f)) for f in (".credentials.json", ".claude.json"))):
            continue
        homes.append({"name": name, "logged_in": home_login(path, name), "windows": usage(name)})
    return {"homes": homes}


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
