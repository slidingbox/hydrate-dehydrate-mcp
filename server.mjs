#!/usr/bin/env node
// The entrypoint, deliberately trivial. It used to guard on
// `import.meta.url === file://${process.argv[1]}` so the test could import the
// helpers without starting a server — but under npx, argv[1] is the
// node_modules/.bin symlink, never the real path, so the guard was always
// false and the published server connected to nothing and exited silently.
// A file that only ever runs has no condition left to get wrong.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./lib.mjs";

await server.connect(new StdioServerTransport());
