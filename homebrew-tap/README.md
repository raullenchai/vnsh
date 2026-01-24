# Homebrew Tap for vnsh

This is the official Homebrew tap for [vnsh](https://vnsh.dev) - The Ephemeral Dropbox for AI.

## Installation

```bash
# Add the tap
brew tap raullenchai/vnsh

# Install vnsh
brew install vnsh
```

Or install directly:

```bash
brew install raullenchai/vnsh/vnsh
```

## Usage

```bash
# Upload a file
vn secret.env

# Pipe content
echo "hello world" | vn
git diff | vn
cat crash.log | vn

# Read/decrypt a URL
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."

# Custom expiry (1-168 hours)
vn --ttl 1 temp.txt
```

## Requirements

- macOS or Linux
- OpenSSL (installed automatically as a dependency)

## Links

- [Website](https://vnsh.dev)
- [GitHub](https://github.com/raullenchai/vnsh)
- [Documentation](https://github.com/raullenchai/vnsh#readme)

## License

MIT
