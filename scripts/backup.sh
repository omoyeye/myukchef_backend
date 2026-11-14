#!/bin/sh
# Daily backup of everything MYUKCHEF can't rebuild: the database, uploaded photos and videos, and
# chefs' private certificate copies. Keeps the last 14 days.
#
#   npm run backup                      (from the myukchef_backend folder)
#
# Run it every night with cron (DirectAdmin: Advanced Features, Cron Jobs), for example at 3am:
#   0 3 * * * cd /home/USER/myukchef_backend && sh scripts/backup.sh >> logs/backup.log 2>&1
#
# Copies on the same server don't survive the server being lost. Copy the backups folder somewhere
# else too, for example with rclone to cloud storage, or DirectAdmin's own backup to another host.
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-../backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$BACKUP_DIR"

# DATABASE_URL comes from .env unless it's already set.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -n 1 | cut -d= -f2-)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL isn't set" >&2
    exit 1
fi

# The login goes in a private file (never on the command line), written by Node so passwords
# with any characters in them work.
CNF="$(mktemp)"
trap 'rm -f "$CNF"' EXIT
chmod 600 "$CNF"
DB_NAME="$(node -e '
const u = new URL(process.argv[1]);
const v = (s) => JSON.stringify(decodeURIComponent(s));
require("fs").writeFileSync(process.argv[2], ["[client]", "user=" + v(u.username), "password=" + v(u.password), "host=" + u.hostname, "port=" + (u.port || "3306"), ""].join(String.fromCharCode(10)), { mode: 0o600 });
process.stdout.write(decodeURIComponent(u.pathname.slice(1)));
' "$DATABASE_URL" "$CNF")"

echo "$(date) backing up database $DB_NAME"
mysqldump --defaults-extra-file="$CNF" --single-transaction --routines --no-tablespaces "$DB_NAME" | gzip -9 > "$BACKUP_DIR/db-$STAMP.sql.gz"

echo "$(date) backing up uploads"
UPLOADS="${UPLOAD_DIR:-uploads}"
PRIVATE="${PRIVATE_UPLOAD_DIR:-private_uploads}"
# Small copies of photos are left out: they're rebuilt automatically when needed.
tar -czf "$BACKUP_DIR/files-$STAMP.tar.gz" --exclude='.thumbs' "$UPLOADS" $( [ -d "$PRIVATE" ] && echo "$PRIVATE" )
chmod 600 "$BACKUP_DIR"/*-"$STAMP".*

echo "$(date) removing backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date) done: $(ls -1 "$BACKUP_DIR" | wc -l) files in $BACKUP_DIR"
