#!/bin/bash
# Install cluster watcher on a remote host.
# Usage: ./setup.sh [hostname]   (default: qtm)

HOST="${1:-qtm}"

echo "Installing cluster watcher on $HOST..."

# Create remote directory
ssh "$HOST" 'mkdir -p ~/.cluster-status'

# Copy watcher script
scp "$(dirname "$0")/watcher.sh" "$HOST:~/.cluster-status/watcher.sh"
ssh "$HOST" 'chmod +x ~/.cluster-status/watcher.sh'

# Create empty manifest if it doesn't exist
ssh "$HOST" 'touch ~/.cluster-status/manifest.tsv'

# Install cron job (every 2 minutes)
ssh "$HOST" '(crontab -l 2>/dev/null | grep -v "watcher.sh"; echo "*/2 * * * * ~/.cluster-status/watcher.sh >> ~/.cluster-status/watcher.log 2>&1") | crontab -'

# Run once immediately to populate status.json
ssh "$HOST" '~/.cluster-status/watcher.sh'

echo "Done. Watcher installed on $HOST, running every 2 minutes."
echo ""
echo "To verify: ssh $HOST 'crontab -l'"
