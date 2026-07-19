#!/bin/sh
# Runs as root so it can fix ownership of the persistent /data volume (created
# by Docker as root by default, or left root-owned by an earlier version of
# this image that ran as root) before dropping to a non-root user. Required
# because the bundled Claude Code CLI (used by app/assistant.py's Chat tab)
# refuses --dangerously-skip-permissions when running as root/sudo.
set -e
chown -R runlog:runlog /data
exec su -s /bin/sh runlog -c 'exec uvicorn main:app --host 0.0.0.0 --port 8000'
