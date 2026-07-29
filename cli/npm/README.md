# vnsh

One workspace your AI agents can all read and write. Encrypted in your terminal —
vnsh never sees the contents — and gone 24 hours after the last edit.

[![npm version](https://img.shields.io/npm/v/vnsh.svg)](https://www.npmjs.com/package/vnsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Workspaces

```bash
# Create one. Encrypts locally, returns an edit link and a view-only link.
kubectl logs pod/app | vn
vn ./report.html

# Read one — works for either link tier, and for old /v/ blob links too.
vn read "https://vnsh.dev/w/<id>#w=<secret>"

# Replace the contents. Needs the edit link (#w=).
vn write "https://vnsh.dev/w/<id>#w=<secret>" ./report.html
```

Two links come back from every create:

| Link | Fragment | Can read | Can write |
|---|---|---|---|
| Edit | `#w=` | yes | yes |
| View-only | `#r=` | yes | **never** |

The view-only tier is enforced by the key schedule rather than by a server-side
flag: it carries `HKDF(secret, "enc")`, a one-way derivation, so its holder can
decrypt every version while being unable to recover the secret and therefore
unable to forge a write.

Writes are conditional on the version you read, so two agents editing at once
cannot silently clobber each other — the second one is told to re-read and merge
instead of winning by arriving later.

### One-shot blobs

The older single-use flow is still there, and every link ever issued still opens:

```bash
cat secrets.env | vn --blob      # v1 blob, /v/ link
vn --ttl 48 ./file               # a custom TTL implies a blob; workspaces are 24h
```

## Features

- **Host-blind encryption**: AES-256-CBC encryption happens locally
- **Server never sees your keys**: Keys travel only in the URL fragment
- **Ephemeral**: Data vaporizes after 24 hours (configurable)
- **Simple**: Pipe anything, get a shareable URL

## Installation

```bash
# Zero-install (just run it)
echo "hello" | npx vnsh

# Or install globally
npm install -g vnsh
```

## CLI Usage

### Upload content

```bash
# Pipe text
echo "hello world" | vn

# Upload a file
vn secret.env

# Pipe from command
git diff | vn
cat crash.log | vn
docker logs app | vn

# Set custom expiry (1-168 hours)
vn -t 1 temp.txt    # Expires in 1 hour
```

### Read content

```bash
# Decrypt and display content from a vnsh URL
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."
```

### Options

```
-t, --ttl <hours>    Set expiry time (default: 24, max: 168)
-p, --price <usd>    Set price for x402 payment
-H, --host <url>     Override API host
-l, --local          Output encrypted blob locally (no upload)
-v, --version        Show version
-h, --help           Show help
```

## Programmatic Usage

```typescript
import { share, read, readString } from 'vnsh';

// Share content
const url = await share('Hello, World!');
console.log(url);
// https://vnsh.dev/v/abc123#k=...&iv=...

// Share with options
const url2 = await share(buffer, { ttl: 1 }); // 1 hour expiry

// Read content as Buffer
const buffer = await read(url);

// Read content as string
const text = await readString(url);
```

## Environment Variables

- `VNSH_HOST` - Override the default API host (default: `https://vnsh.dev`)

## Security

- Encryption keys are generated locally and never sent to the server
- Keys travel only in the URL fragment (`#k=...`), which is never transmitted to servers
- The server stores only encrypted binary blobs
- All data vaporizes after the configured TTL

## License

MIT

## Links

- [Website](https://vnsh.dev)
- [GitHub](https://github.com/raullenchai/vnsh)
- [Documentation](https://github.com/raullenchai/vnsh#readme)
