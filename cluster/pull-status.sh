#!/bin/bash
# Pull cluster status from remote host to local cache.
# Usage: ./pull-status.sh [hostname]   (default: qtm)

HOST="${1:-qtm}"
LOCAL_DIR="$HOME/.claude/cluster-status"
mkdir -p "$LOCAL_DIR"

scp -q "$HOST:~/.cluster-status/status.json" "$LOCAL_DIR/${HOST}.json" 2>/dev/null
