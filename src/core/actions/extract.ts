/**
 * `extract` action — pull the type bus manifest out of the current project
 * (API-repo side) and either write it to disk or, with `--check`, just
 * validate it as a CI gate without touching the filesystem.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { extractBusManifest, type ExtractError } from "../bus/extract.js";
import { diffManifests, parseManifest, type BusDiff } from "../bus/manifest.js";

export interface ExtractActionOptions {
	project?: string;
	out?: string;
	check?: boolean;
	cwd?: string;
	/** File path or http(s) URL of a baseline manifest to diff against. */
	diffBaseline?: string;
	/** Fail (ok: false) when the diff against `diffBaseline` removed any types. */
	failOnRemoved?: boolean;
}

export interface ExtractActionResult {
	ok: boolean;
	errors: ExtractError[];
	typeCount: number;
	wrote: string | null;
	diff: BusDiff | null;
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
		return { ok: false, errors, typeCount: 0, wrote: null, diff: null };
	}

	const typeCount = Object.values(manifest!.barrels).flat().length;

	let diff: BusDiff | null = null;
	if (options.diffBaseline) {
		const baselineJson = /^https?:\/\//.test(options.diffBaseline)
			? await (await fetch(options.diffBaseline)).text()
			: await readFile(path.resolve(cwd, options.diffBaseline), "utf8");
		const baseline = parseManifest(baselineJson);
		diff = diffManifests(baseline, manifest!);
		for (const name of diff.added) logger.info(`bus: + ${name}`);
		for (const name of diff.changed) logger.info(`bus: ~ ${name}`);
		for (const name of diff.removed) logger.warn(`bus: - ${name} (removed)`);
		if (options.failOnRemoved && diff.removed.length > 0) {
			logger.error(
				`Type bus removed ${diff.removed.length} type(s) present in the baseline — failing (--fail-on-removed).`,
			);
			return { ok: false, errors: [], typeCount, wrote: null, diff };
		}
	}

	if (options.check) {
		logger.done(`Type bus OK — ${typeCount} type(s), no violations.`);
		return { ok: true, errors: [], typeCount, wrote: null, diff };
	}

	const outPath = path.resolve(cwd, options.out ?? "chowbea.bus.json");
	await writeFile(outPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	logger.done(`Wrote ${typeCount} type(s) to ${outPath}`);
	return { ok: true, errors: [], typeCount, wrote: outPath, diff };
}
