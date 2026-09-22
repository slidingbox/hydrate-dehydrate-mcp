# @slidingbox/hydrate-dehydrate-mcp

> **Discontinued:** SlidingBox was permanently decommissioned on 2026-09-21.
> Its service endpoints are unavailable. This repository remains archived as an
> accurate historical record; do not install or depend on this package.

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

Two more tools answer a third question: **has this web page changed since it was
last checked — by anyone?** Every check of a URL is kept as hashes, so you learn
what changed without the page ever being stored or returned.

```
has_page_changed("https://vendor.example/pricing")
  ->  {"changed": {"content": true, "scripts": false, ...},
       "sections": {"total": 12, "changed": [3]},
       "history": {"observations": 7, "last_changed_at": "2026-09-18T..."}}

watch_page("https://shop.example/checkout", "https://my-agent.example/hooks/drift")
  ->  {"watch_id": "...", "secret": "...", "checks": 168, "expires_at": "..."}
      then a signed POST to the callback whenever an hourly check finds a change
```

`changed.scripts` reports whether the set of external scripts a page loads has
changed — the kind of change PCI DSS 11.6.1 asks payment-page operators to
detect. It is an observation from outside the page, not a compliance control.

## Why there is no hosted version

There is deliberately no hosted instance of this server, and no entry under
Glama's connectors or any other remote-MCP directory. `store_secret` encrypts in
the process it runs in, so a hosted instance would receive your plaintext before
it ever became ciphertext, and `retrieve_secret` takes a token that carries the
decryption key. Hosting either one moves the secret into somebody else's
environment, which is the exact thing this exists to avoid.

Running it locally is the feature, not a limitation. The `Dockerfile` in this
repo exists so directory listing checks can start the server and introspect it;
it is not a deployment target.

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

Storing is free. Reading costs $0.02 and a verify costs $0.01. A page's first
`has_page_changed` is free; later checks cost $0.05, and a `watch_page` costs $0.50
once. Evaluation keys cover reads and verifies; page checks and watches are paid by
wallet only. The ways to pay:

| Variable | What it does |
| --- | --- |
| `SLIDINGBOX_API_KEY` | An evaluation key (`sbk_<id>.<hmac>`). Covers a fixed number of reads for free. Get one instantly: `curl -X POST https://slidingbox.ai/v1/key` — no account, no email. |
| `SLIDINGBOX_PRIVATE_KEY` | A Base wallet holding USDC. Reads are paid per call over [x402](https://x402.org) — no account, no invoice, no subscription. |
| `SLIDINGBOX_URL` | Defaults to `https://slidingbox.ai`. |
| `SLIDINGBOX_DRIFT_URL` | Defaults to `https://drift.slidingbox.ai` (page checks and watches). |
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
pointer.

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
