# @slidingbox/hydrate-dehydrate-mcp

An MCP server for handing a secret from one agent, machine, or person to another
without leaving a copy behind.

`store_secret` encrypts on your machine and returns one token. Whoever holds the
token gets the secret exactly once — the first successful read delivers it and
destroys it, and a second read returns nothing. Slidingbox stores only
ciphertext: the key travels in the token and is never sent to the server.

```
store_secret("sk-live-...")  ->  sb_PApm-Ui...#0zgYgq2d...
                                 ^ pointer, on the server   ^ key, never sent

retrieve_secret("sb_PApm-Ui...#0zgYgq2d...")  ->  sk-live-...   (and it's gone)
```

A third tool, `verify_endpoint`, answers a different question: before your agent
pays an unfamiliar x402 endpoint, is it live, is it payable, and do its price
and payee still match what the CDP Bazaar catalog advertises.

```
verify_endpoint("https://example.com/v1/thing")
  ->  {"payable": true, "price_matches_catalog": false,
       "reason_codes": ["price_drift"], "last_changed_at": "2026-09-01T..."}
```

## Install

```json
{
  "mcpServers": {
    "hydrate-dehydrate": {
      "command": "npx",
      "args": ["-y", "@slidingbox/hydrate-dehydrate-mcp"],
      "env": { "SLIDINGBOX_API_KEY": "sbk_..." }
    }
  }
}
```

That block goes in your MCP client's config — `claude_desktop_config.json` for
Claude Desktop, or `claude mcp add` for Claude Code.

## Paying for reads

Storing is free. Reading costs $0.02 and a verify costs $0.01. Two ways to cover
either:

| Variable | What it does |
| --- | --- |
| `SLIDINGBOX_API_KEY` | An evaluation key (`sbk_<id>.<hmac>`). Covers a fixed number of reads for free. Get one instantly: `curl -X POST https://slidingbox.ai/v1/key` — no account, no email. |
| `SLIDINGBOX_PRIVATE_KEY` | A Base wallet holding USDC. Reads are paid per call over [x402](https://x402.org) — no account, no invoice, no subscription. |
| `SLIDINGBOX_URL` | Defaults to `https://slidingbox.ai`. |
| `SLIDINGBOX_NETWORK` | Defaults to `eip155:8453` (Base mainnet). |

With neither set, `store_secret` still works, and `retrieve_secret` and
`verify_endpoint` tell you which one to configure. `SLIDINGBOX_PRIVATE_KEY` signs payments: give it a
wallet funded for this purpose and nothing else.

## What it is good for

- Passing a credential between two agents that share no store and no account.
- Sending a secret through a channel you would rather it not persist in — the
  token in the chat log is inert the moment it is read.
- Proving a handoff happened once. A replayed token fails visibly instead of
  quietly serving a second copy.

## What it is not

Not storage, backup, messaging, or key management. Secrets live 60–900 seconds
and then expire. Not for protected health information or payment-card data.

## How it works

Encryption is AES-256-GCM, done in this process before anything is sent. The
server receives `{ciphertext, iv}` and a time-to-live, and returns an opaque
pointer. That is the whole reason this is a local stdio server rather than a
route on the API: a remote MCP server would have to receive your plaintext in
order to encrypt it.

Payment, when a wallet is configured, is x402 — the read returns `402`, the
client signs an EIP-3009 authorization for $0.02 USDC, and retries. Paying
wallets are screened against the OFAC SDN list before settlement; see
<https://slidingbox.ai/compliance>.

- API: <https://slidingbox.ai/developers>
- Agent-readable: <https://slidingbox.ai/llms.txt>, <https://slidingbox.ai/.well-known/slidingbox.json>

## Development

```bash
npm install
npm test        # offline: crypto round-trip and token parsing
node server.mjs # speaks MCP over stdio
```

## If this stops working

Slidingbox is a small product and may be retired. This server is built to say so
rather than fail opaquely: a retired service answers `410`, and a domain that no
longer resolves is reported as a retirement, not as a stack trace. Nothing you
store is ever held longer than 900 seconds, so a shutdown cannot strand data.

ISC © SLIDINGBOX LLC
