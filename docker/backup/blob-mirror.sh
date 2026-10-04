#!/bin/sh
# Mirrors the WireHub bucket into /backups/blobs (the backup-mirror service in
# compose.backup.yaml) with the read-only backup key, every
# BACKUP_MIRROR_INTERVAL seconds. Objects are content-addressed, so a sync
# only ever copies new files; deletes are mirrored too, and restic snapshots
# keep what was deleted for the retention period.
set -eu
interval="${BACKUP_MIRROR_INTERVAL:-3600}"
mkdir -p /backups/blobs
while true; do
  if rclone sync --fast-list --checksum "garage:${S3_BUCKET:-wirehub}" /backups/blobs; then
    echo "backup-mirror: synced $(find /backups/blobs -type f | wc -l) object(s)"
  else
    echo "backup-mirror: sync failed" >&2
  fi
  sleep "$interval"
done
