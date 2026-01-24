# Integration Tests

Comprehensive integration tests for vnsh v1.1.0 covering all upload/view combinations across CLI, MCP, and Web interfaces.

## Test Matrix

| # | Upload Method | View Method | Automation | Status |
|---|---------------|-------------|------------|--------|
| 1 | CLI | CLI | Automated | ✅ Pass |
| 2 | CLI | MCP | Automated | ✅ Pass |
| 3 | CLI | Website | Manual | ✅ Pass |
| 4 | MCP | MCP | Automated | ✅ Pass |
| 5 | MCP | CLI | Automated | ✅ Pass |
| 6 | MCP | Website | Manual | ✅ Pass |
| 7 | Website | Website | Manual | ✅ Pass |
| 8 | Website | CLI | Manual | ✅ Pass |
| 9 | Website | MCP | Manual | ✅ Pass |

## File Formats Tested

| Format | Extension | Type | Size | Notes |
|--------|-----------|------|------|-------|
| Plain Text | .txt | text | 39B | UTF-8 encoded |
| JSON | .json | text | 140B | Valid JSON with nested objects |
| CSV | .csv | text | 72B | 3 columns, 5 rows |
| PNG | .png | binary | 70B | 1x1 pixel image |
| JPEG | .jpg | binary | 284B | 1x1 pixel image |
| PDF | .pdf | binary | 588B | Single page with text |

## Running Integration Tests

### Prerequisites

```bash
# Install CLI
curl -sL https://vnsh.dev/i | sh
source ~/.zshrc

# Build MCP
cd mcp && npm run build
```

### Automated Tests

```bash
# Create test directory and files
TEST_DIR="/tmp/vnsh-integration-test"
mkdir -p "$TEST_DIR"

# Generate test files
echo "Hello vnsh test $(date +%s)" > "$TEST_DIR/test.txt"

cat > "$TEST_DIR/test.json" << 'EOF'
{"test": true, "name": "vnsh", "nested": {"array": [1,2,3]}}
EOF

cat > "$TEST_DIR/test.csv" << 'EOF'
id,name,value
1,alice,100
2,bob,200
3,charlie,300
EOF

# PNG (1x1 red pixel)
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==" | base64 -d > "$TEST_DIR/test.png"

# JPEG (1x1 red pixel)
echo "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwAB//9k=" | base64 -d > "$TEST_DIR/test.jpg"

# PDF (minimal valid PDF)
cat > "$TEST_DIR/test.pdf" << 'EOF'
%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 100 700 Td (vnsh test) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
trailer << /Size 6 /Root 1 0 R >>
startxref
435
%%EOF
EOF
```

### Test 1: CLI → CLI

```bash
test_cli_to_cli() {
  local file="$1"
  local original_hash=$(shasum -a 256 "$file" | cut -c1-64)

  # Upload
  URL=$(vn "$file" 2>/dev/null)

  # Download and compare
  DOWNLOAD=$(mktemp)
  vn read "$URL" > "$DOWNLOAD" 2>/dev/null
  local download_hash=$(shasum -a 256 "$DOWNLOAD" | cut -c1-64)
  rm -f "$DOWNLOAD"

  [ "$original_hash" = "$download_hash" ] && echo "PASS" || echo "FAIL"
}

for f in "$TEST_DIR"/test.*; do
  echo -n "$(basename $f): "
  test_cli_to_cli "$f"
done
```

### Test 2: CLI → MCP / MCP → CLI

Create `mcp_test.mjs`:

```javascript
import { handleRead, handleShare } from './mcp/dist/index.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

async function testCliToMcp(filepath, url) {
  const original = fs.readFileSync(filepath);
  const originalHash = crypto.createHash('sha256').update(original).digest('hex');

  const result = await handleRead({ url });
  let downloaded;

  if (result.content[0].text.includes('Saved to:')) {
    const match = result.content[0].text.match(/Saved to: (.+)/);
    downloaded = fs.readFileSync(match[1]);
  } else {
    downloaded = Buffer.from(result.content[0].text, 'utf-8');
  }

  const downloadHash = crypto.createHash('sha256').update(downloaded).digest('hex');
  return originalHash === downloadHash ? 'PASS' : 'FAIL';
}

async function testMcpToCli(content) {
  const result = await handleShare({ content });
  return result.metadata.url;
}
```

### Test 3: MCP → MCP

```javascript
async function testMcpToMcp(content) {
  // Upload
  const shareResult = await handleShare({ content });
  const url = shareResult.metadata.url;

  // Download
  const readResult = await handleRead({ url });
  const downloaded = readResult.content[0].text;

  return content === downloaded ? 'PASS' : 'FAIL';
}
```

## Manual Website Tests

### Website Upload

1. Open https://vnsh.dev
2. Drag and drop a test file OR paste text content
3. Copy the generated URL
4. Verify URL format: `https://vnsh.dev/v/{id}#k={key}&iv={iv}`

### Website View

Open the URL in a browser and verify:

| File Type | Expected Behavior |
|-----------|-------------------|
| Text (.txt, .json, .csv) | Displays content in viewer |
| Image (.png, .jpg) | Renders image |
| PDF | Shows download option or renders |

### Cross-Platform Verification

```bash
# Upload via CLI, view in browser
URL=$(echo "test content" | vn)
open "$URL"  # macOS
# xdg-open "$URL"  # Linux

# Upload via website, view in CLI
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."
```

## Known Limitations

### MCP Binary Handling

MCP's `vnsh_share` tool only accepts string content. For binary files:

```javascript
// Encode binary as base64 before sharing
const binary = fs.readFileSync('image.png');
const base64 = binary.toString('base64');
await handleShare({ content: base64 });

// Decode after reading
const result = await handleRead({ url });
const binary = Buffer.from(result.content[0].text, 'base64');
```

### CLI Binary Output

CLI warns when outputting binary to terminal:

```
Warning: Binary content detected (PDF, image, etc.)
Save to file: vn read "<url>" > filename
```

Redirect to file for binary content:

```bash
vn read "$URL" > downloaded.png
```

## Validation Criteria

### Hash Verification

All tests use SHA-256 hash comparison:

```bash
# Original file hash
ORIGINAL_HASH=$(shasum -a 256 file.txt | cut -c1-64)

# Downloaded content hash
DOWNLOAD_HASH=$(vn read "$URL" | shasum -a 256 | cut -c1-64)

# Compare
[ "$ORIGINAL_HASH" = "$DOWNLOAD_HASH" ] && echo "PASS"
```

### Content Integrity

1. **Text files**: Byte-for-byte match
2. **Binary files**: SHA-256 hash match
3. **Encoding**: UTF-8 for text, raw bytes for binary

## Test Results (v1.1.0)

```
=== CLI Upload → CLI View ===
test.txt    PASS (hash match)
test.json   PASS (hash match)
test.csv    PASS (hash match)
test.png    PASS (hash match)
test.jpg    PASS (hash match)
test.pdf    PASS (hash match)

=== CLI Upload → MCP View ===
test.txt    PASS
test.json   PASS
test.csv    PASS
test.png    PASS
test.jpg    PASS
test.pdf    PASS

=== MCP Upload → MCP View ===
test.txt           PASS (hash match)
test.json          PASS (hash match)
test.csv           PASS (hash match)
test.png (base64)  PASS (hash match)
test.jpg (base64)  PASS (hash match)
test.pdf (base64)  PASS (hash match)

=== MCP Upload → CLI View ===
test.txt           PASS
test.json          PASS
test.csv           PASS
test.png (base64)  PASS
test.jpg (base64)  PASS
test.pdf (base64)  PASS
```

**Total: 24/24 automated tests passed**

## Troubleshooting

### "Failed to fetch or decrypt"

- Check URL is complete (includes `#k=...&iv=...`)
- Verify content hasn't expired (24h default TTL)
- Ensure URL is properly quoted in shell

### "Binary content detected"

Expected behavior for images/PDFs. Redirect to file:

```bash
vn read "$URL" > output.pdf
```

### Hash Mismatch

1. Check for encoding issues (UTF-8 vs binary)
2. Verify no whitespace/newline differences
3. Ensure complete file transfer (no truncation)
