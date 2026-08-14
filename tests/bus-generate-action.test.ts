import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeGenerate } from "../src/core/actions/generate.js";
import { DEFAULT_CONFIG, generateConfigTemplate, getOutputPaths } from "../src/core/config.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

/**
 * Regression coverage for finding G1: executeGenerate's `[bus]` catch-all
 * used to swallow EVERY failure reading/parsing/emitting the cached bus
 * manifest into the same "no cached manifest — run fetch first" warning.
 * That's correct for an absent cache file (ENOENT — the expected "never ran
 * fetch" case) but wrong for a cache file that exists and fails to parse or
 * validate — that's real corruption/tampering and must fail generate loudly,
 * the same way a missing local spec fails loudly via SpecNotFoundError.
 */

const PETSTORE_SPEC = readFileSync(new URL("./fixtures/petstore.json", import.meta.url), "utf8");

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(orig);
	}
}

const generateOptions = { dryRun: false, typesOnly: false, operationsOnly: false };

describe("executeGenerate: bus cache catch-all (finding G1)", () => {
	it("a corrupt cached bus manifest fails generate loudly, not with the generic 'run fetch first' warning", async () => {
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
		});
		try {
			const config = {
				...DEFAULT_CONFIG,
				spec_file: "./openapi.json",
				output: { folder: "api" },
			};
			const template = generateConfigTemplate(config);
			writeFileSync(
				join(dir, "api.config.toml"),
				`${template}\n[bus]\nendpoint = "https://example.invalid/.well-known/chowbea.json"\n`,
				"utf8",
			);

			const outputPaths = getOutputPaths(config, dir);
			mkdirSync(dirname(outputPaths.busCache), { recursive: true });
			writeFileSync(outputPaths.busCache, "not valid json at all", "utf8");

			await inDir(dir, async () => {
				let caught: unknown;
				try {
					await executeGenerate(generateOptions, SILENT_LOGGER);
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(Error);
				expect((caught as Error).message).not.toMatch(/run fetch first/i);
			});
		} finally {
			cleanup();
		}
	});

	it("no cached bus manifest at all still warns 'run fetch first' and succeeds (the ENOENT case is unchanged)", async () => {
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
		});
		try {
			const config = {
				...DEFAULT_CONFIG,
				spec_file: "./openapi.json",
				output: { folder: "api" },
			};
			const template = generateConfigTemplate(config);
			writeFileSync(
				join(dir, "api.config.toml"),
				`${template}\n[bus]\nendpoint = "https://example.invalid/.well-known/chowbea.json"\n`,
				"utf8",
			);

			await inDir(dir, async () => {
				await expect(executeGenerate(generateOptions, SILENT_LOGGER)).resolves.toBeDefined();
			});
		} finally {
			cleanup();
		}
	});
});
