#!/bin/sh
# Mirrors the WireHub bucket into /backups/blobs (the backup-mirror service,
# profile `backup` in compose.yaml) every BACKUP_MIRROR_INTERVAL seconds.
# backup-init copies this file from the app image into the secrets volume,
# which the stock rclone image runs it from. Objects are content-addressed,
# so a sync only ever copies new files; deletes are mirrored too, and restic
# snapshots keep what was deleted for the retention period.
#
# The store is S3_ENDPOINT / S3_REGION / S3_BUCKET; the key is the read-only
# backup key (S3_BACKUP_ACCESS_KEY_ID / _SECRET_ACCESS_KEY, or their _FILE
# forms — garage-init writes the bundled Garage's there), else the app's key.
set -eu

# value of $1, else the contents of the file named by ${1}_FILE
secret() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    eval "file=\${$1_FILE:-}"
    if [ -n "$file" ] && [ -r "$file" ]; then value="$(tr -d '\n' < "$file")"; fi
  fi
  printf '%s' "$value"
}

key_id="$(secret S3_BACKUP_ACCESS_KEY_ID)"
key_secret="$(secret S3_BACKUP_SECRET_ACCESS_KEY)"
if [ -z "$key_id" ] || [ -z "$key_secret" ]; then
  key_id="$(secret S3_ACCESS_KEY_ID)"
  key_secret="$(secret S3_SECRET_ACCESS_KEY)"
fi
if [ -z "$key_id" ] || [ -z "$key_secret" ]; then
  echo "backup-mirror: no S3 key to read the bucket with" >&2
  exit 1
fi

export RCLONE_CONFIG_STORE_TYPE=s3
export RCLONE_CONFIG_STORE_PROVIDER=Other
export RCLONE_CONFIG_STORE_ENDPOINT="${S3_ENDPOINT:-http://garage:3900}"
export RCLONE_CONFIG_STORE_REGION="${S3_REGION:-garage}"
export RCLONE_CONFIG_STORE_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$key_id"
export RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$key_secret"

interval="${BACKUP_MIRROR_INTERVAL:-3600}"
mkdir -p /backups/blobs
while true; do
  if rclone sync --fast-list --checksum "store:${S3_BUCKET:-wirehub}" /backups/blobs; then
    echo "backup-mirror: synced $(find /backups/blobs -type f | wc -l) object(s)"
  else
    echo "backup-mirror: sync failed" >&2
  fi
  sleep "$interval"
done
