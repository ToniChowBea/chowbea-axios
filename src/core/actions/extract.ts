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
	/** Re-run extraction on every `.ts` file change under `cwd` instead of exiting after one pass. */
	watch?: boolean;
	/** Test seam: called with the result of every extraction cycle (including the first) in watch mode. */
	onCycle?: (result: ExtractActionResult) => void;
	/** Test seam: hands back a disposer that stops the watcher. The CLI path never calls it. */
	registerStop?: (stop: () => void) => void;
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

	async function runOnce(): Promise<ExtractActionResult> {
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

	if (options.watch) {
		const first = await runOnce();
		options.onCycle?.(first);
		let timer: NodeJS.Timeout | null = null;
		const { watch } = await import("node:fs");
		const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
			if (!filename || !filename.endsWith(".ts")) return;
			if (filename.includes("node_modules") || filename.includes("chowbea.bus.json")) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				void runOnce()
					.then((r) => options.onCycle?.(r))
					.catch((err) => logger.error(String(err)));
			}, 300);
		});
		options.registerStop?.(() => watcher.close());
		// CLI path: the process stays alive on the watcher handle until SIGINT.
		return first;
	}

	return runOnce();
}
