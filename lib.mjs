// Slidingbox MCP server: everything except the entrypoint.
//
// Encryption happens HERE, in the client process, which is the whole reason
// this is a local stdio server and not a route on the Worker: a remote MCP
// server would have to receive plaintext to encrypt it, and the service is
// built so that never happens.
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

// Clients that install this from an MCPB bundle substitute ${user_config.*}
// into the environment, and an optional value the user left blank can arrive
// either empty or as the un-substituted placeholder itself. Both mean unset,
// and neither is caught by `??`: an empty SLIDINGBOX_URL leaves BASE_URL blank,
// a literal placeholder sent as X-API-Key reads to the service as a forged key
// and earns a penalty strike, and one handed to privateKeyToAccount below
// throws before the server ever speaks MCP.
const env = (name) => {
	const value = process.env[name];
	return value && !value.startsWith("${") ? value : undefined;
};

const BASE_URL = (env("SLIDINGBOX_URL") ?? "https://slidingbox.ai").replace(
	/\/$/,
	"",
);
const API_KEY = env("SLIDINGBOX_API_KEY");
const PRIVATE_KEY = env("SLIDINGBOX_PRIVATE_KEY");
const NETWORK = env("SLIDINGBOX_NETWORK") ?? "eip155:8453";

// Mirrors the server's own limits so a too-large secret fails here with a
// sentence instead of a 413 from three layers down.
const MAX_PLAINTEXT_BYTES = 131072;
const TTL_MIN_SECONDS = 60;
const TTL_MAX_SECONDS = 900;

const toB64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (s) => new Uint8Array(Buffer.from(s, "base64url"));

export async function encrypt(plaintext) {
	const key = await crypto.subtle.generateKey(
		{ name: "AES-GCM", length: 256 },
		true,
		["encrypt", "decrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return {
		ciphertext: toB64url(new Uint8Array(ciphertext)),
		iv: toB64url(iv),
		key: toB64url(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
	};
}

export async function decrypt({ ciphertext, iv, key }) {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		fromB64url(key),
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromB64url(iv) },
		cryptoKey,
		fromB64url(ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}

// One string carries the pointer and the key, because two strings is how a key
// ends up pasted into the same channel as the pointer anyway. The fragment
// half never leaves this process except in the tool result.
export const packToken = (pointer, key) => `${pointer}#${key}`;

export function parseToken(token) {
	const match = /^(sb_[A-Za-z0-9_-]{43})#([A-Za-z0-9_-]{43})$/.exec(
		token.trim(),
	);
	if (!match) {
		throw new Error(
			"Not a Slidingbox token. Expected sb_<43 chars>#<43 chars>, exactly as store_secret returned it.",
		);
	}
	return { pointer: match[1], key: match[2] };
}

// A paying fetch when a wallet is configured, a plain one otherwise. Built once:
// the x402 client holds the signer.
const payingFetch = PRIVATE_KEY
	? wrapFetchWithPayment(
			fetch,
			new x402Client().register(
				NETWORK,
				new ExactEvmScheme(privateKeyToAccount(PRIVATE_KEY)),
			),
		)
	: fetch;

// The service answers every failure as {"error": "<code>"}. Turn the codes an
// operator can actually act on into instructions; pass the rest through.
export function explain(status, code) {
	// An installed copy of this server outlives the service it talks to. 410 is
	// how a retired Slidingbox says so on purpose; see DEPLOY.md § Retiring.
	if (status === 410) {
		return `${RETIRED} Nothing was stored, and nothing was charged.`;
	}
	if (status === 402) {
		return "Payment required. Set SLIDINGBOX_API_KEY to an issued evaluation key, or SLIDINGBOX_PRIVATE_KEY to a funded Base wallet, and retry.";
	}
	if (status === 404) {
		return "Nothing there. A secret is delivered exactly once — this token was already read, or its time-to-live expired.";
	}
	if (status === 409)
		return "Another paid read of this token is settling. Retry in a moment.";
	if (status === 429) return "Rate limited. Wait a minute and retry.";
	if (status === 403 && code === "payment_refused") {
		return "The payment was refused and nothing was charged. The paying wallet is on the OFAC SDN list: https://slidingbox.ai/compliance";
	}
	return `Slidingbox returned ${status} ${code}.`;
}

const RETIRED = "Slidingbox has been retired — see https://slidingbox.ai.";

// fetch throws rather than returning a status when the host is gone, which is
// exactly what a retired service looks like from here. Say so instead of
// surfacing a bare TypeError to whoever is holding the secret.
export function explainUnreachable(error, baseUrl) {
	const code = error?.cause?.code ?? error?.code;
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return `${baseUrl} does not resolve. ${RETIRED} If you set SLIDINGBOX_URL yourself, check it.`;
	}
	return `Could not reach ${baseUrl}: ${code ?? error?.message ?? "network error"}. It may be down, retired (see https://slidingbox.ai), or blocked from this machine.`;
}

async function readError(res) {
	const code = await res
		.json()
		.then((body) => body?.error ?? "unknown")
		.catch(() => "unknown");
	return explain(res.status, code);
}

const fail = (message) => ({
	isError: true,
	content: [{ type: "text", text: message }],
});
const ok = (text) => ({ content: [{ type: "text", text }] });

// Read rather than repeated: a hardcoded version silently drifts from the
// published one on every release, and MCP clients show this to the user.
const { version } = createRequire(import.meta.url)("./package.json");

// The product, not the parent brand — this string is what an MCP client
// displays in its server list.
export const server = new McpServer({ name: "hydrate-dehydrate", version });

server.registerTool(
	"store_secret",
	{
		title: "Store a secret",
		description:
			"Encrypt a secret locally and store the ciphertext on Slidingbox. Returns one token that carries both the pointer and the decryption key. Hand that token to whoever should read it: the first read delivers the secret and destroys it. Slidingbox never sees the plaintext or the key.",
		inputSchema: {
			text: z
				.string()
				.min(1)
				.describe(
					"The secret to store. Encrypted before it leaves this machine.",
				),
			ttl_seconds: z
				.number()
				.int()
				.min(TTL_MIN_SECONDS)
				.max(TTL_MAX_SECONDS)
				.optional()
				.describe(
					`How long it may sit unread, ${TTL_MIN_SECONDS}-${TTL_MAX_SECONDS} seconds (default ${TTL_MAX_SECONDS}).`,
				),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: true,
		},
	},
	async ({ text, ttl_seconds }) => {
		const size = Buffer.byteLength(text, "utf8");
		if (size > MAX_PLAINTEXT_BYTES) {
			return fail(
				`Secret is ${size} bytes; the limit is ${MAX_PLAINTEXT_BYTES}.`,
			);
		}
		const { ciphertext, iv, key } = await encrypt(text);
		let res;
		try {
			res = await fetch(`${BASE_URL}/v1/dehydrate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ciphertext,
					iv,
					content_type: "text/plain",
					ttl_seconds: ttl_seconds ?? TTL_MAX_SECONDS,
				}),
			});
		} catch (error) {
			return fail(explainUnreachable(error, BASE_URL));
		}
		if (!res.ok) return fail(await readError(res));
		const { pointer, expires_at } = await res.json();
		return ok(
			`${packToken(pointer, key)}\n\nExpires ${expires_at} if nobody reads it. Anyone holding this token can read the secret once — the key is the half after the #, and it was never sent to the server.`,
		);
	},
);

server.registerTool(
	"retrieve_secret",
	{
		title: "Retrieve a secret",
		description:
			"Read a secret stored on Slidingbox, using the token from store_secret. This destroys it: the token is dead the instant this succeeds, and a second call returns nothing. Reading is paid (x402) unless an evaluation key is configured.",
		inputSchema: {
			token: z
				.string()
				.describe("The sb_<pointer>#<key> token from store_secret."),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
	},
	async ({ token }) => {
		let pointer;
		let key;
		try {
			({ pointer, key } = parseToken(token));
		} catch (error) {
			return fail(error.message);
		}
		let res;
		try {
			res = await payingFetch(`${BASE_URL}/v1/hydrate/${pointer}`, {
				headers: API_KEY ? { "x-api-key": API_KEY } : {},
			});
		} catch (error) {
			return fail(explainUnreachable(error, BASE_URL));
		}
		if (!res.ok) return fail(await readError(res));
		const body = await res.json();
		try {
			return ok(
				await decrypt({ ciphertext: body.ciphertext, iv: body.iv, key }),
			);
		} catch {
			return fail(
				"The secret was delivered and destroyed, but it would not decrypt — the key half of the token does not match it. That copy is gone; ask for a new one.",
			);
		}
	},
);
