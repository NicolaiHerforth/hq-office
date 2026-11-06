#!/bin/sh
# One machine's health as key=value: cores, load1, cpu_busy and mem_used (percent), swap_used_gb and disk_free_gb.
# With the argument `temp`, only temp_gb: the temp folders' size, a walk of their files, so the server asks less often.
# Runs locally or over ssh (`ssh host sh -s < machine-stats.sh`). macOS and Linux.
# launchd gives a minimal PATH without /usr/sbin, so set the usual one first.
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH
if [ "$1" = "temp" ]; then
  if [ "$(uname)" = "Darwin" ]; then dirs="/private/tmp $(getconf DARWIN_USER_TEMP_DIR)"; else dirs="/tmp"; fi
  # A file that goes while du walks, or one it may not read, is not a failed reading.
  temp_gb=$(nice -n 19 du -sk $dirs 2>/dev/null | awk '{ s += $1 } END { if (NR) printf "%.2f", s / 1048576 }')
  [ -n "$temp_gb" ] || { echo "temp unreadable" >&2; exit 1; }
  echo "temp_gb=$temp_gb"
  exit 0
fi
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
if [ "$(uname)" = "Darwin" ]; then
  load1=$(sysctl -n vm.loadavg | awk '{print $2}')
  # iostat's second line is the idle share over one second. top -l 2 gives the same number but costs about
  # two CPU-seconds on a busy machine, because it walks every process.
  cpu_idle=$(iostat -n 0 -c 2 -w 1 | tail -1 | awk '{print $3}')
  total=$(sysctl -n hw.memsize)
  page=$(sysctl -n hw.pagesize)
  # free, inactive and speculative pages can be reclaimed, so they do not count as used
  reclaimable=$(vm_stat | awk '/Pages (free|inactive|speculative):/ {gsub("\\.", "", $NF); s += $NF} END {print s + 0}')
  mem_used=$(awk -v t="$total" -v f="$reclaimable" -v p="$page" 'BEGIN { printf "%.1f", (1 - f * p / t) * 100 }')
  # "total = 2048.00M  used = 123.00M  free = 1925.00M"
  swap_used_gb=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | awk '{ printf "%.2f", $1 / 1024 }')
else
  load1=$(awk '{print $1}' /proc/loadavg)
  cpu_idle=$(top -bn2 -d1 | grep 'Cpu(s)' | tail -1 | sed -E 's/.* ([0-9.,]+) id.*/\1/' | tr , .)
  mem_used=$(free | awk '/Mem:/ { printf "%.1f", $3 / $2 * 100 }')
  swap_used_gb=$(free | awk '/Swap:/ { printf "%.2f", $3 / 1048576 }')
fi
# An empty reading is a failed sample, not a zero.
for v in "$load1" "$cpu_idle" "$mem_used"; do [ -n "$v" ] || { echo "sample incomplete" >&2; exit 1; }; done
cpu_busy=$(awk -v i="$cpu_idle" 'BEGIN { printf "%.1f", 100 - i }')
disk_free_gb=$(df -Pk "${HOME:-/}" 2>/dev/null | tail -1 | awk '{ printf "%.1f", $4 / 1048576 }')
# Swap and disk are left out when unreadable: the sample still counts.
echo "cores=$cores load1=$load1 cpu_busy=$cpu_busy mem_used=$mem_used${swap_used_gb:+ swap_used_gb=$swap_used_gb}${disk_free_gb:+ disk_free_gb=$disk_free_gb}"
