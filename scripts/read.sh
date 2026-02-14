#!/bin/sh
# vnsh read script - downloads and decrypts a vnsh.dev URL
# Usage: read.sh <vnsh_url>
# Output: path to decrypted temp file with correct extension

set -e

URL="$1"

if [ -z "$URL" ]; then
  echo "Usage: read.sh <vnsh_url>" >&2
  exit 1
fi

# Check dependencies
command -v openssl >/dev/null 2>&1 || { echo "Error: openssl required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl required" >&2; exit 1; }

# Parse URL components
# URL format: https://vnsh.dev/v/{id}#k={key}&iv={iv}
ID=$(echo "$URL" | sed 's|.*/v/||;s|#.*||')
KEY=$(echo "$URL" | sed 's|.*#k=||;s|&.*||')
IV=$(echo "$URL" | sed 's|.*&iv=||')

if [ -z "$ID" ] || [ -z "$KEY" ] || [ -z "$IV" ]; then
  echo "Error: Invalid vnsh URL format" >&2
  exit 1
fi

# Create temp file
TMPFILE=$(mktemp /tmp/vnsh-decrypted-XXXXXX)

# Download and decrypt
curl -sf "https://vnsh.dev/api/blob/$ID" | \
  openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "$TMPFILE"

if [ ! -s "$TMPFILE" ]; then
  rm -f "$TMPFILE"
  echo "Error: Decryption failed or empty content" >&2
  exit 1
fi

# Detect file type from magic bytes and rename with correct extension
detect_ext() {
  HEAD=$(xxd -p -l 12 "$1" 2>/dev/null | tr -d '\n')
  case "$HEAD" in
    89504e47*) echo "png" ;;
    ffd8ff*) echo "jpg" ;;
    474946*) echo "gif" ;;
    52494646*57454250) echo "webp" ;;
    1a45dfa3*) echo "webm" ;;
    *66747970*) echo "mp4" ;;
    25504446*) echo "pdf" ;;
    504b0304*) echo "zip" ;;
    1f8b*) echo "gz" ;;
    494433*) echo "mp3" ;;
    664c6143*) echo "flac" ;;
    *) echo "bin" ;;
  esac
}

# Check if content is text (no null bytes in first 1KB)
is_text() {
  # Count null bytes in first 1KB - if zero, it's text
  NULL_COUNT=$(head -c 1024 "$1" | tr -cd '\0' | wc -c | tr -d ' ')
  [ "$NULL_COUNT" -eq 0 ]
}

if is_text "$TMPFILE"; then
  EXT="txt"
else
  EXT=$(detect_ext "$TMPFILE")
fi

# Rename with extension
OUTFILE="${TMPFILE}.${EXT}"
mv "$TMPFILE" "$OUTFILE"

# Output the file path
echo "$OUTFILE"
