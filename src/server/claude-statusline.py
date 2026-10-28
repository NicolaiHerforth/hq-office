# The status line of a lane HQ Office started on a Claude account: `python3 -I claude-statusline.py <account>`.
# Claude pipes its status payload in on stdin; this keeps the account's rate limits (percent used and reset time,
# nothing else from the payload) where account-stats.py reads them, and prints the account's name for the lane's bar.
import json
import os
import sys
import tempfile

HOME = os.path.expanduser("~")
account = sys.argv[1] if len(sys.argv) > 1 else "default"

try:
    limits = (json.load(sys.stdin) or {}).get("rate_limits")
except ValueError:
    limits = None

kept = {}
for key in ("five_hour", "seven_day"):
    w = limits.get(key) if isinstance(limits, dict) else None
    if isinstance(w, dict) and isinstance(w.get("used_percentage"), (int, float)):
        kept[key] = {"used_percentage": w["used_percentage"], "resets_at": w.get("resets_at")}

if kept and account.replace("-", "").isalnum():
    folder = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state"), "hq-office", "claude-usage")
    try:
        os.makedirs(folder, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=folder)
        with os.fdopen(handle, "w") as out:
            json.dump({"rate_limits": kept}, out)
        os.replace(temp, os.path.join(folder, account + ".json"))
    except OSError:
        pass

week = kept.get("seven_day", {}).get("used_percentage")
print(f"account {account}" + (f" · week {round(100 - week)}% left" if week is not None else ""))
