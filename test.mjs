// Offline self-check: the crypto round-trip and the token format, which are the
// only parts of this server that can be wrong without the network saying so.
// `node test.mjs`. The end-to-end path is exercised by scripts/qa-x402.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	decrypt,
	encrypt,
	explain,
	explainUnreachable,
	packToken,
	parseToken,
} from "./lib.mjs";

const POINTER = "sb_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V";

const secret = "correct horse battery staple — ünïcode, \n newlines, 🔐";
const { ciphertext, iv, key } = await encrypt(secret);
assert.equal(await decrypt({ ciphertext, iv, key }), secret, "round-trip");

// The key is 256 bits and travels only in the token; the server gets neither.
assert.equal(Buffer.from(key, "base64url").length, 32, "key is 32 bytes");
assert.equal(Buffer.from(iv, "base64url").length, 12, "iv is 12 bytes");
assert.ok(!ciphertext.includes(key), "key is not inside the ciphertext");

const token = packToken(POINTER, key);
assert.deepEqual(parseToken(token), { pointer: POINTER, key }, "pack/parse");
assert.deepEqual(
	parseToken(` ${token}\n`),
	{ pointer: POINTER, key },
	"tolerates whitespace",
);

// A wrong key must fail closed, not return garbage.
const { key: otherKey } = await encrypt("something else");
await assert.rejects(
	() => decrypt({ ciphertext, iv, key: otherKey }),
	"wrong key fails",
);

for (const bad of [
	"",
	POINTER,
	`${POINTER}#`,
	`#${key}`,
	`${POINTER}#${key}#extra`,
	`sb_short#${key}`,
	`${POINTER.replace("sb_", "xx_")}#${key}`,
]) {
	assert.throws(
		() => parseToken(bad),
		/Not a Slidingbox token/,
		`rejects ${JSON.stringify(bad)}`,
	);
}

// How this server behaves once the service it fronts is gone, which is the one
// path that cannot be tested against a live server.
assert.match(explain(410, "gone"), /retired/i, "410 reads as a retirement");
assert.match(
	explain(402, "payment_required"),
	/SLIDINGBOX_API_KEY/,
	"402 names the fix",
);
assert.match(
	explain(404, "not_found"),
	/exactly once/,
	"404 explains one-shot delivery",
);
assert.match(explain(500, "boom"), /500 boom/, "unknown codes pass through");

const dns = Object.assign(new Error("fetch failed"), {
	cause: { code: "ENOTFOUND" },
});
assert.match(
	explainUnreachable(dns, "https://x"),
	/retired/i,
	"dead host reads as retired",
);
assert.match(
	explainUnreachable(new Error("nope"), "https://x"),
	/Could not reach https:\/\/x/,
);

// The published server is launched through a node_modules/.bin symlink, where
// process.argv[1] is the link and never the real file. 0.1.0 shipped an
// entrypoint guard that compared the two, so it connected to nothing and
// exited silently — and running `node server.mjs` directly could never show
// it. Launch it the way npm does, and require an actual answer.
const shim = join(
	mkdtempSync(join(tmpdir(), "sbmcp-")),
	"hydrate-dehydrate-mcp",
);
symlinkSync(resolve("server.mjs"), shim);

const reply = await new Promise((done, fail) => {
	const child = spawn(process.execPath, [shim], {
		stdio: ["pipe", "pipe", "ignore"],
		// Exactly what an MCPB client sends when the user leaves the optional
		// config blank. Unguarded, the placeholder reaches privateKeyToAccount
		// and throws at import, so the server answers nothing at all.
		env: {
			...process.env,
			SLIDINGBOX_URL: "",
			SLIDINGBOX_API_KEY: `\${user_config.api_key}`,
			SLIDINGBOX_PRIVATE_KEY: `\${user_config.private_key}`,
		},
	});
	let out = "";
	const timer = setTimeout(() => {
		child.kill();
		fail(
			new Error(
				"the server answered nothing in 10s — the entrypoint did not connect",
			),
		);
	}, 10_000);
	child.stdout.on("data", (chunk) => {
		out += chunk;
		const line = out.split("\n").find((l) => l.trim().startsWith("{"));
		if (!line) return;
		clearTimeout(timer);
		child.kill();
		done(JSON.parse(line));
	});
	child.on("error", fail);
	child.stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "t", version: "0" },
			},
		})}\n`,
	);
});
assert.equal(
	reply.result.serverInfo.name,
	"hydrate-dehydrate",
	"launched via a bin symlink, it speaks MCP",
);
// Drift between these two is invisible until a user reads it in their client.
assert.equal(
	reply.result.serverInfo.version,
	createRequire(import.meta.url)("./package.json").version,
	"serverInfo.version tracks package.json",
);

console.log("@slidingbox/hydrate-dehydrate-mcp self-check PASS");
