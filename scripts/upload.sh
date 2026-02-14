#!/bin/sh
# vnsh upload script - encrypts and uploads a file to vnsh.dev
# Usage: upload.sh <file_path> [ttl_hours]
# Output: https://vnsh.dev/v/{id}#k={key}&iv={iv}

set -e

FILE="$1"
TTL="${2:-24}"

if [ -z "$FILE" ]; then
  echo "Usage: upload.sh <file_path> [ttl_hours]" >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

# Check dependencies
command -v openssl >/dev/null 2>&1 || { echo "Error: openssl required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl required" >&2; exit 1; }

# Generate encryption keys
KEY=$(openssl rand -hex 32)
IV=$(openssl rand -hex 16)

# Encrypt and upload
RESPONSE=$(openssl enc -aes-256-cbc -K "$KEY" -iv "$IV" -in "$FILE" | \
  curl -s -X POST \
    --data-binary @- \
    -H "Content-Type: application/octet-stream" \
    "https://vnsh.dev/api/drop?ttl=$TTL")

# Extract ID from response
ID=$(echo "$RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

if [ -z "$ID" ]; then
  echo "Error: Upload failed - $RESPONSE" >&2
  exit 1
fi

# Output the full URL
echo "https://vnsh.dev/v/${ID}#k=${KEY}&iv=${IV}"
