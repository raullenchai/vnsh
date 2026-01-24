# ADR-001: AES-256-CBC Encryption Algorithm

## Status

Accepted

## Context

Opaque needs a symmetric encryption algorithm that:

1. Is widely supported across platforms (browsers, CLI, servers)
2. Has well-understood security properties
3. Is easy to implement correctly
4. Works with existing tools (OpenSSL, WebCrypto, Node.js)

### Options Considered

#### AES-256-GCM (Authenticated Encryption)

**Pros:**
- Provides authentication (integrity + confidentiality)
- Detects tampering
- Modern, recommended choice

**Cons:**
- Nonce management is critical (reuse = catastrophic)
- WebCrypto implementation differences
- Slightly more complex API

#### AES-256-CBC (Block Cipher Mode)

**Pros:**
- Universal support (OpenSSL, WebCrypto, every language)
- Simple mental model
- Deterministic output (same key+IV = same ciphertext)
- Battle-tested for decades

**Cons:**
- No built-in authentication (padding oracle attacks possible)
- IV must be random and unique
- Padding overhead

#### ChaCha20-Poly1305

**Pros:**
- Modern, fast on software
- Good WebCrypto support
- Authenticated

**Cons:**
- Not available in OpenSSL by default
- Less universal than AES

## Decision

**Use AES-256-CBC** with PKCS#7 padding.

### Rationale

1. **OpenSSL Compatibility**: The CLI uses `openssl enc` which has perfect CBC support. This allows zero-dependency operation.

2. **Cross-Platform Verification**: Users can verify encryption works using standard tools:
   ```bash
   openssl enc -aes-256-cbc -K $KEY -iv $IV -in plain.txt -out cipher.bin
   ```

3. **Simplicity**: CBC is conceptually simpler. For ephemeral, single-use blobs, the lack of authentication is acceptable because:
   - Blobs are short-lived (max 7 days)
   - Tampering results in decryption failure, not silent corruption
   - No oracle exists (single-shot decrypt, no feedback)

4. **Deterministic Testing**: Same inputs produce same outputs, making cross-platform tests trivial.

## Consequences

### Positive

- CLI can use system OpenSSL (no dependencies)
- All platforms produce identical ciphertext
- Easy to debug and verify

### Negative

- No authentication (mitigated by use case)
- Must ensure IV uniqueness (use crypto.randomBytes)
- Padding overhead (1-16 bytes per blob)

### Risks

- **Padding Oracle**: Not applicable — no decrypt oracle exists
- **IV Reuse**: Mitigated by always generating random IVs

## Implementation Notes

```typescript
// Node.js
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const key = randomBytes(32); // 256 bits
const iv = randomBytes(16);  // 128 bits

const cipher = createCipheriv('aes-256-cbc', key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
```

```bash
# OpenSSL CLI
openssl enc -aes-256-cbc -K $KEY_HEX -iv $IV_HEX
```

```javascript
// WebCrypto
const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext);
```

## References

- [NIST SP 800-38A](https://csrc.nist.gov/publications/detail/sp/800-38a/final) - CBC Mode
- [OpenSSL enc](https://www.openssl.org/docs/man1.1.1/man1/enc.html)
- [WebCrypto AES-CBC](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
