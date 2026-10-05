#!/bin/sh
# Copy the bucket mirror (/backups/blobs) back into the bucket after a
# restore (docs/self-hosting.md, "Restore"):
#   docker compose run --rm --entrypoint sh backup-mirror /run/wirehub/backup/blob-restore.sh
# Uses the app's key (it writes); objects are content-addressed, so copying
# over a bucket that already holds some of them is safe.
set -eu
secret() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    eval "file=\${$1_FILE:-}"
    if [ -n "$file" ] && [ -r "$file" ]; then value="$(tr -d '\n' < "$file")"; fi
  fi
  printf '%s' "$value"
}
key_id="$(secret S3_ACCESS_KEY_ID)"
key_secret="$(secret S3_SECRET_ACCESS_KEY)"
[ -n "$key_id" ] && [ -n "$key_secret" ] || { echo "blob-restore: no app S3 key" >&2; exit 1; }
export RCLONE_CONFIG_STORE_TYPE=s3 RCLONE_CONFIG_STORE_PROVIDER=Other RCLONE_CONFIG_STORE_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_STORE_ENDPOINT="${S3_ENDPOINT:-http://garage:3900}" RCLONE_CONFIG_STORE_REGION="${S3_REGION:-garage}"
export RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$key_id" RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$key_secret"
rclone copy --checksum /backups/blobs "store:${S3_BUCKET:-wirehub}"
echo "blob-restore: copied $(find /backups/blobs -type f | wc -l) object(s) into ${S3_BUCKET:-wirehub}"
