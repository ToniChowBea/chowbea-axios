import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeGenerate } from "../src/core/actions/generate.js";
import { DEFAULT_CONFIG, generateConfigTemplate, getOutputPaths } from "../src/core/config.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
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

function entry(name: string, declaration: string, source = "src/types.chowbea.ts") {
	return { name, kind: "type" as const, declaration, source, line: 1, hash: hashText(declaration) };
}

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

describe("executeGenerate: pinned bus manifest ([bus].file)", () => {
	const pinnedConfig = () => ({
		...DEFAULT_CONFIG,
		api_endpoint: "https://staging.example.invalid/openapi.json",
		spec_file: "./openapi.json",
		output: { folder: "api" },
		bus: { endpoint: "https://staging.example.invalid/bus.json", file: "chowbea.bus.json" },
	});

	it("emits _generated/bus from the pinned file and ignores the _internal cache", async () => {
		const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
		const stale = buildManifest({ core: [entry("Old", "export type Old = 1;")] });
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
			"chowbea.bus.json": `${JSON.stringify(manifest, null, "\t")}\n`,
		});
		try {
			const config = pinnedConfig();
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(config), "utf8");
			const outputPaths = getOutputPaths(config, dir);
			mkdirSync(dirname(outputPaths.busCache), { recursive: true });
			writeFileSync(outputPaths.busCache, `${JSON.stringify(stale, null, "\t")}\n`, "utf8");

			await inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER));
			const emitted = readFileSync(join(outputPaths.busDir, "core.ts"), "utf8");
			expect(emitted).toContain("Grade");
			expect(emitted).not.toContain("Old");
		} finally {
			cleanup();
		}
	});

	it("missing pinned file fails with an actionable 'run sync' error", async () => {
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
		});
		try {
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(pinnedConfig()), "utf8");
			await expect(inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER))).rejects.toThrow(
				/pinned bus manifest not found.*chowbea-axios sync/s,
			);
		} finally {
			cleanup();
		}
	});

	it("a tampered pinned manifest fails loudly (hash integrity)", async () => {
		const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
		const tampered = JSON.stringify({ ...manifest, hash: "0".repeat(64) });
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
			"chowbea.bus.json": tampered,
		});
		try {
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(pinnedConfig()), "utf8");
			await expect(inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER))).rejects.toThrow(
				/hash does not match/,
			);
		} finally {
			cleanup();
		}
	});
});
