/**
 * Loader for the optional `chowbea.config.{mjs,js}` file.
 *
 * The file sits next to `api.config.toml` in the project root and can
 * export hook functions that chowbea passes straight through to
 * `openapiTS()`. Use it to convert `format: date-time` to `Date`, attach
 * JSDoc validation annotations, brand opaque IDs, and so on.
 *
 * Example `chowbea.config.mjs`:
 *
 *   import ts from "typescript";
 *
 *   const DATE = ts.factory.createTypeReferenceNode("Date");
 *
 *   export default {
 *     transform(schemaObject) {
 *       if (schemaObject.format === "date-time") return DATE;
 *     },
 *   };
 *
 * TypeScript config files (`chowbea.config.ts`) are not supported yet —
 * they would require either a JIT loader (jiti) or Node's
 * `--experimental-strip-types` flag, neither of which we want to require
 * of every consumer.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Logger } from "../adapters/logger-interface.js";
import { ConfigError } from "./errors.js";
import type { GenerationHooks } from "./generator.js";

const CANDIDATE_FILENAMES = ["chowbea.config.mjs", "chowbea.config.js"] as const;

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Look for a `chowbea.config.{mjs,js}` next to `api.config.toml`, dynamic-
 * import it, and return its `GenerationHooks`. Returns an empty object if
 * no config file is present (the common case).
 *
 * Throws `ConfigError` only if a config file is present but malformed —
 * a missing file is silent.
 */
export async function loadHooks(
	projectRoot: string,
	logger: Logger,
): Promise<GenerationHooks> {
	for (const filename of CANDIDATE_FILENAMES) {
		const filePath = path.join(projectRoot, filename);
		if (!(await fileExists(filePath))) continue;

		logger.debug({ filePath }, "Loading chowbea.config hook file");

		let mod: unknown;
		try {
			mod = await import(pathToFileURL(filePath).href);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ConfigError(
				`Failed to load ${filename}: ${message}`,
				"Check that the file exports a default object or named hook functions.",
			);
		}

		const hooks = extractHooks(mod);
		validateHooks(hooks, filename);

		logger.info(
			{ filePath, hookNames: Object.keys(hooks) },
			"Loaded generator hooks from chowbea.config",
		);
		return hooks;
	}

	return {};
}

/**
 * Pull the hooks object out of a dynamically-imported module. We accept
 * either `export default {...}` or named exports `export const transform = ...`.
 */
function extractHooks(mod: unknown): Record<string, unknown> {
	if (typeof mod !== "object" || mod === null) return {};

	const m = mod as Record<string, unknown>;
	const fromDefault =
		typeof m.default === "object" && m.default !== null
			? (m.default as Record<string, unknown>)
			: {};

	const fromNamed: Record<string, unknown> = {};
	for (const key of ["transform", "postTransform", "transformProperty"]) {
		if (key in m) fromNamed[key] = m[key];
	}

	// Named exports win over default when both are present (predictable for
	// consumers who mix and match).
	return { ...fromDefault, ...fromNamed };
}

function validateHooks(
	hooks: Record<string, unknown>,
	filename: string,
): asserts hooks is GenerationHooks {
	for (const key of Object.keys(hooks)) {
		if (!["transform", "postTransform", "transformProperty"].includes(key)) {
			throw new ConfigError(
				`${filename}: unknown hook "${key}"`,
				`Recognised hooks: transform, postTransform, transformProperty.`,
			);
		}
		if (typeof hooks[key] !== "function") {
			throw new ConfigError(
				`${filename}: "${key}" must be a function, got ${typeof hooks[key]}`,
				`Export a function: export const ${key} = (schemaObject, options) => { ... }`,
			);
		}
	}
}
