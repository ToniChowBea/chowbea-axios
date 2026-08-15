#!/usr/bin/env node
// Forwards to the `chowbea` CLI. `bin` entries are not in the exports map, so
// resolve the dependency's package.json and read its bin path from there.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("chowbea/package.json");
const pkg = require("chowbea/package.json");
const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.chowbea;
const binPath = join(dirname(pkgJsonPath), binRel);

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
