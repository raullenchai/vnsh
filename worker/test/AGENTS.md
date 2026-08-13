# Worker test guidance

- Drain every response body, including responses used only for status or header assertions.
- Browser viewer requests must include `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`; automated fetches intentionally receive the agent guide.
- Assert on the exact element, header, or structured response field. A substring may also occur in comments embedded in served HTML and produce a false positive.
- Test R2 compare-and-swap failures and D1/R2 partial failures explicitly for write-path changes.
