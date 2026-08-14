/**
 * `extract` action — pull the type bus manifest out of the current project
 * (API-repo side) and either write it to disk or, with `--check`, just
 * validate it as a CI gate without touching the filesystem.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { extractBusManifest, type ExtractError } from "../bus/extract.js";

export interface ExtractActionOptions {
	project?: string;
	out?: string;
	check?: boolean;
	cwd?: string;
}

export interface ExtractActionResult {
	ok: boolean;
	errors: ExtractError[];
	typeCount: number;
	wrote: string | null;
}

export async function executeExtract(
	options: ExtractActionOptions,
	logger: Logger,
): Promise<ExtractActionResult> {
	const cwd = options.cwd ?? process.cwd();
	const { manifest, errors } = extractBusManifest({
		projectRoot: cwd,
		tsconfigPath: options.project ? path.resolve(cwd, options.project) : undefined,
	});

	if (errors.length > 0) {
		for (const err of errors) {
			logger.error(`${err.file}:${err.line}  ${err.message}`);
		}
		logger.error(`Type bus extraction failed with ${errors.length} error(s).`);
		return { ok: false, errors, typeCount: 0, wrote: null };
	}

	const typeCount = Object.values(manifest!.barrels).flat().length;
	if (options.check) {
		logger.done(`Type bus OK — ${typeCount} type(s), no violations.`);
		return { ok: true, errors: [], typeCount, wrote: null };
	}

	const outPath = path.resolve(cwd, options.out ?? "chowbea.bus.json");
	await writeFile(outPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	logger.done(`Wrote ${typeCount} type(s) to ${outPath}`);
	return { ok: true, errors: [], typeCount, wrote: outPath };
}
