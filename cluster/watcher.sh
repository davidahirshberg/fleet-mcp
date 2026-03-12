#!/bin/bash
# Cluster status watcher — runs on qtm via cron.
# Uses squeue to get running/pending/completed counts per job array.
# Writes structured status to ~/.cluster-status/status.json
#
# Install: crontab -e, add:
#   */2 * * * * ~/.cluster-status/watcher.sh >> ~/.cluster-status/watcher.log 2>&1

STATUS_DIR="$HOME/.cluster-status"
STATUS_OUT="$STATUS_DIR/status.json"

mkdir -p "$STATUS_DIR"

USER=$(whoami)
TIMESTAMP=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)

# --- Parse squeue ---
# %i = full job ID (with array info like 46610_[49-200%5] or 46610_43)
# %j = job name, %T = state
declare -A NAME_RUNNING
declare -A NAME_PENDING
declare -A NAME_ARRAYMAX
declare -A NAME_MINFUTURE  # lowest pending task ID → everything below is done

while IFS=$'\t' read -r fulljobid name state; do
  fulljobid=$(echo "$fulljobid" | tr -d ' ')
  state=$(echo "$state" | tr -d ' ')
  name=$(echo "$name" | tr -d ' ')
  [ -z "$name" ] && continue

  if [ "$state" = "RUNNING" ]; then
    NAME_RUNNING[$name]=$(( ${NAME_RUNNING[$name]:-0} + 1 ))
  elif [ "$state" = "PENDING" ]; then
    # Check for array range pattern: jobid_[start-end%throttle]
    if [[ "$fulljobid" =~ \[([0-9]+)-([0-9]+) ]]; then
      start="${BASH_REMATCH[1]}"
      end="${BASH_REMATCH[2]}"
      pending_count=$((end - start + 1))
      NAME_PENDING[$name]=$(( ${NAME_PENDING[$name]:-0} + pending_count ))
      # Track array max and min future task
      if [ -z "${NAME_ARRAYMAX[$name]}" ] || [ "$end" -gt "${NAME_ARRAYMAX[$name]}" ]; then
        NAME_ARRAYMAX[$name]="$end"
      fi
      if [ -z "${NAME_MINFUTURE[$name]}" ] || [ "$start" -lt "${NAME_MINFUTURE[$name]}" ]; then
        NAME_MINFUTURE[$name]="$start"
      fi
    else
      NAME_PENDING[$name]=$(( ${NAME_PENDING[$name]:-0} + 1 ))
    fi
  fi
done < <(squeue -u "$USER" --format="%i	%j	%T" --noheader 2>/dev/null)

# --- Build JSON ---
echo "{" > "$STATUS_OUT"
echo "  \"timestamp\": \"$TIMESTAMP\"," >> "$STATUS_OUT"
echo "  \"user\": \"$USER\"," >> "$STATUS_OUT"
echo "  \"jobs\": [" >> "$STATUS_OUT"
first=true

# Collect all job names
declare -A ALL_NAMES
for name in "${!NAME_RUNNING[@]}" "${!NAME_PENDING[@]}"; do
  ALL_NAMES[$name]=1
done

for name in $(echo "${!ALL_NAMES[@]}" | tr ' ' '\n' | sort); do
  running=${NAME_RUNNING[$name]:-0}
  pending=${NAME_PENDING[$name]:-0}

  # Compute completed: tasks 0..(minfuture-1) minus running tasks
  completed=0
  arraymax=${NAME_ARRAYMAX[$name]:-0}
  minfuture=${NAME_MINFUTURE[$name]:-0}
  if [ "$minfuture" -gt 0 ]; then
    completed=$((minfuture - running))
    [ "$completed" -lt 0 ] && completed=0
  fi
  total=$((completed + running + pending))

  if [ "$first" = true ]; then first=false; else echo "," >> "$STATUS_OUT"; fi
  printf '    {"name": "%s", "completed": %d, "running": %d, "pending": %d, "total": %d}' \
    "$name" "$completed" "$running" "$pending" "$total" >> "$STATUS_OUT"
done
echo "" >> "$STATUS_OUT"
echo "  ]" >> "$STATUS_OUT"
echo "}" >> "$STATUS_OUT"
