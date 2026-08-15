#!/usr/bin/env node
// Forwards to the `chowbea` CLI. `bin` entries are not in the exports map, so
// resolve the dependency's package.json and read its bin path from there.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("chowbea/package.json");
const pkg = require("chowbea/package.json");
// Mirror BIN_KEYS in src/core/local-resolution.ts: accept either bin name,
// preferring "chowbea".
const binRel =
	typeof pkg.bin === "string" ? pkg.bin : pkg.bin.chowbea ?? pkg.bin["chowbea-axios"];
if (!binRel) {
	console.error("chowbea-axios: could not find the chowbea CLI bin");
	process.exit(1);
}
const binPath = join(dirname(pkgJsonPath), binRel);

// `env: process.env` must forward the FULL environment, not a filtered copy.
// chowbea's router (src/router.ts) sets CHOWBEA_LOCAL_DELEGATED=1 on its own
// delegated spawns, and decideDelegation (src/core/local-resolution.ts) reads
// that sentinel to stop re-delegating. If a project hoists only this shim
// locally while `chowbea` itself is nested, the router hands off to this
// project-local shim/bin.js — dropping the sentinel here would let it
// re-delegate forever (fork bomb).
const result = spawnSync(process.execPath, [binPath, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});
if (result.error) {
	console.error(`chowbea-axios: could not run chowbea (${result.error.message})`);
	process.exit(1);
}
if (typeof result.status === "number") process.exit(result.status);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(1);
