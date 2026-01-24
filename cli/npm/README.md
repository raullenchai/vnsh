# vnsh-cli

The Ephemeral Dropbox for AI - CLI tool for encrypted file sharing.

[![npm version](https://img.shields.io/npm/v/vnsh-cli.svg)](https://www.npmjs.com/package/vnsh-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Features

- **End-to-end encryption**: AES-256-CBC encryption happens locally
- **Host-blind**: Server never sees your encryption keys
- **Ephemeral**: Data auto-destructs after 24 hours (configurable)
- **Simple**: Pipe anything, get a shareable URL

## Installation

```bash
npm install -g vnsh-cli
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
import { share, read, readString } from 'vnsh-cli';

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
- All data auto-destructs after the configured TTL

## License

MIT

## Links

- [Website](https://vnsh.dev)
- [GitHub](https://github.com/raullenchai/vnsh)
- [Documentation](https://github.com/raullenchai/vnsh#readme)
