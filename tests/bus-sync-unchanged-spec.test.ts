import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeFetch } from "../src/core/actions/fetch.js";
import { executeWatch } from "../src/core/actions/watch.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { DEFAULT_CONFIG, generateConfigTemplate } from "../src/core/config.js";
import { makeTempGitRepo, type TempGitRepo } from "./helpers/git-repo.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

/**
 * Regression coverage for finding B0: the bus must sync on every successful
 * fetch/cycle, whether or not the OpenAPI spec itself changed. Both
 * `executeFetch` and watch's `runCycle` used to early-return on an unchanged
 * spec before ever reaching `syncBusFromConfig` — so a bus-only edit on the
 * server never propagated to the frontend until the spec also happened to
 * change. These tests keep the spec fixed across two runs and only flip the
 * bus manifest, so they fail against the old early-return code.
 */

const PETSTORE_SPEC = readFileSync(
	new URL("./fixtures/petstore.json", import.meta.url),
	"utf8",
);

const entry = (name: string, declaration: string) => ({
	name,
	kind: "type" as const,
	declaration,
	source: "src/bus.chowbea.ts",
	line: 1,
	hash: hashText(declaration),
});

let server: Server | null = null;
afterEach(() => {
	server?.close();
	server = null;
});

/** Serves whichever manifest `current()` returns at request time — lets a test flip versions mid-run. */
function serveDynamic(current: () => object): Promise<string> {
	return new Promise((resolve) => {
		server = createServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(current()));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server!.address() as { port: number };
			resolve(`http://127.0.0.1:${addr.port}/.well-known/chowbea.json`);
		});
	});
}

/** generateConfigTemplate() doesn't render [bus] — append it by hand. */
function scaffold(repo: TempGitRepo, busEndpoint: string): void {
	repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
	repo.write("openapi.json", PETSTORE_SPEC);
	const template = generateConfigTemplate({
		...DEFAULT_CONFIG,
		spec_file: "./openapi.json",
		output: { folder: "api" },
	});
	repo.write("api.config.toml", `${template}\n[bus]\nendpoint = "${busEndpoint}"\n`);
}

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(orig);
	}
}

const fetchOptions = { force: false, dryRun: false, typesOnly: false, operationsOnly: false };

describe("bus sync survives an unchanged spec (finding B0)", () => {
	it("executeFetch re-emits bus files on a spec-unchanged run when the bus manifest changed", async () => {
		let manifest = buildManifest({ core: [entry("A", "export type A = 1;")] }, new Date(0));
		const busEndpoint = await serveDynamic(() => manifest);
		const repo = makeTempGitRepo();
		try {
			scaffold(repo, busEndpoint);

			// First run: no cache yet, so the spec is "changed" — generates and does a first bus sync.
			await inDir(repo.dir, () => executeFetch(fetchOptions, SILENT_LOGGER));
			expect(readFileSync(join(repo.dir, "api/_generated/bus/core.ts"), "utf8")).toContain(
				"export type A = 1;",
			);

			// The bus manifest changes; the local spec file (and its cached hash) do not.
			manifest = buildManifest({ core: [entry("A", "export type A = 2;")] }, new Date(0));

			// Second run: spec is unchanged. Pre-fix, executeFetch returned before
			// ever calling syncBusFromConfig, so bus/core.ts would still read "= 1".
			await inDir(repo.dir, () => executeFetch(fetchOptions, SILENT_LOGGER));

			expect(readFileSync(join(repo.dir, "api/_generated/bus/core.ts"), "utf8")).toContain(
				"export type A = 2;",
			);
		} finally {
			repo.cleanup();
		}
	});

	it("watch's runCycle re-emits bus files on a no-changes cycle when the bus manifest changed", async () => {
		let manifest = buildManifest({ core: [entry("A", "export type A = 1;")] }, new Date(0));
		const busEndpoint = await serveDynamic(() => manifest);
		const repo = makeTempGitRepo();
		try {
			scaffold(repo, busEndpoint);

			// Seed the spec cache via a normal fetch so watch's first cycle sees an
			// UNCHANGED spec (same content/hash) but still owes a first bus sync.
			await inDir(repo.dir, () => executeFetch(fetchOptions, SILENT_LOGGER));
			expect(readFileSync(join(repo.dir, "api/_generated/bus/core.ts"), "utf8")).toContain(
				"export type A = 1;",
			);

			manifest = buildManifest({ core: [entry("A", "export type A = 2;")] }, new Date(0));

			// Abort right after the first cycle completes so the test doesn't wait
			// on the poll interval.
			const controller = new AbortController();
			await inDir(repo.dir, () =>
				executeWatch({ intervalMs: 60_000, signal: controller.signal }, SILENT_LOGGER, {
					onCycleComplete: () => controller.abort(),
				}),
			);

			// Pre-fix, runCycle's "no changes" branch returned before syncing the
			// bus, so bus/core.ts would still read "= 1" here.
			expect(readFileSync(join(repo.dir, "api/_generated/bus/core.ts"), "utf8")).toContain(
				"export type A = 2;",
			);
		} finally {
			repo.cleanup();
		}
	});
});
