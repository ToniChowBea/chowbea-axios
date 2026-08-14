import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	GenerationHooks,
	GeneratorPaths,
} from "../../src/core/generator.js";
import { generate, generateClientFiles } from "../../src/core/generator.js";
import type { InstanceConfig } from "../../src/core/config.js";
import { DEFAULT_INSTANCE_CONFIG } from "../../src/core/config.js";
import type { Logger } from "../../src/adapters/logger-interface.js";

const SILENT_LOGGER: Logger = {
	level: "silent",
	header: () => {},
	step: () => {},
	info: (() => {}) as Logger["info"],
	warn: (() => {}) as Logger["warn"],
	error: (() => {}) as Logger["error"],
	debug: (() => {}) as Logger["debug"],
	done: () => {},
	startProgress: () => {},
	stopProgress: () => {},
};

/**
 * Build a temp output tree and matching `GeneratorPaths`.
 * Caller is responsible for `cleanup()`-ing it.
 */
export async function makeTempPaths(): Promise<{
	paths: GeneratorPaths;
	cleanup: () => Promise<void>;
}> {
	const root = join(
		tmpdir(),
		`chowbea-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const internalDir = join(root, "_internal");
	const generatedDir = join(root, "_generated");
	await mkdir(internalDir, { recursive: true });
	await mkdir(generatedDir, { recursive: true });

	const paths: GeneratorPaths = {
		folder: root,
		internal: internalDir,
		generated: generatedDir,
		spec: join(internalDir, "openapi.json"),
		cache: join(internalDir, ".api-cache.json"),
		types: join(generatedDir, "api.types.ts"),
		operations: join(generatedDir, "api.operations.ts"),
		contracts: join(generatedDir, "api.contracts.ts"),
		helpers: join(root, "api.helpers.ts"),
		instance: join(root, "api.instance.ts"),
		error: join(root, "api.error.ts"),
		client: join(root, "api.client.ts"),
		busDir: join(generatedDir, "bus"),
		busCache: join(internalDir, "chowbea.bus.json"),
	};

	return {
		paths,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/**
 * Run the generator end-to-end against an in-memory spec.
 *
 * Exercises the full pipeline including openapi-typescript type emission
 * (now in-process via the Node API — see L4). Tests that need to feed in
 * deliberately invalid specs should construct ones that pass Redocly
 * validation but exercise chowbea's own fallback paths.
 *
 * On any failure (writeFile / generate / readFile), the temp tree is
 * removed before the error propagates so tests don't leak temp dirs
 * across failure cases.
 */
export async function runGenerator(
	spec: object,
	hooks?: GenerationHooks,
): Promise<{
	operations: string;
	contracts: string;
	types: string;
	cleanup: () => Promise<void>;
}> {
	const { paths, cleanup } = await makeTempPaths();
	try {
		await writeFile(paths.spec, JSON.stringify(spec, null, 2), "utf8");
		await generate({ paths, logger: SILENT_LOGGER, hooks });
		const operations = await readFile(paths.operations, "utf8");
		const contracts = await readFile(paths.contracts, "utf8");
		const types = await readFile(paths.types, "utf8");
		return { operations, contracts, types, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}

/**
 * Run `generateClientFiles` against the given instance config.
 * Returns the contents of each emitted file.
 *
 * On any failure, the temp tree is cleaned up before the error
 * propagates.
 */
export async function runClientFiles(
	overrides: Partial<InstanceConfig> = {},
): Promise<{
	helpers: string;
	instance: string;
	error: string;
	client: string;
	cleanup: () => Promise<void>;
}> {
	const { paths, cleanup } = await makeTempPaths();
	try {
		await generateClientFiles({
			paths,
			instanceConfig: { ...DEFAULT_INSTANCE_CONFIG, ...overrides },
			logger: SILENT_LOGGER,
		});
		const helpers = await readFile(paths.helpers, "utf8");
		const instance = await readFile(paths.instance, "utf8");
		const error = await readFile(paths.error, "utf8");
		const client = await readFile(paths.client, "utf8");
		return { helpers, instance, error, client, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}
