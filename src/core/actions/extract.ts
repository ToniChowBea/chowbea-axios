/**
 * `extract` action — pull the type bus manifest out of the current project
 * (API-repo side) and either write it to disk or, with `--check`, just
 * validate it as a CI gate without touching the filesystem.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { extractBusManifest, type ExtractError } from "../bus/extract.js";
import { BUS_FETCH_TIMEOUT_MS } from "../bus/fetch.js";
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
	/** True when extraction produced content identical to the manifest already on disk, so no write happened. */
	unchanged: boolean;
}

/** Directories that only ever hold build output or vendored code — never bus sources. */
const IGNORED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".turbo",
	".cache",
	".git",
]);

/**
 * Whether a changed path should trigger re-extraction.
 *
 * Only project TypeScript sources can contribute bus types. Declaration files
 * are skipped by the extractor itself (`isDeclarationFile`), and build output
 * is rewritten constantly by other watchers — a NestJS `dist/**` rebuild emits
 * `.d.ts` files, which would otherwise re-extract on every single rebuild.
 */
export function shouldTriggerExtract(filename: string): boolean {
	const normalized = filename.split(path.sep).join("/");
	if (!normalized.endsWith(".ts") && !normalized.endsWith(".tsx")) return false;
	if (normalized.endsWith(".d.ts")) return false;
	return !normalized.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

/**
 * Hash of the manifest already at `outPath`, or `null` when it is absent or
 * unreadable. Deliberately a raw parse rather than `parseManifest`: a stale or
 * malformed artifact should simply mean "rewrite it", not throw.
 */
async function readExistingHash(outPath: string): Promise<string | null> {
	try {
		const raw = JSON.parse(await readFile(outPath, "utf8")) as { hash?: unknown };
		return typeof raw.hash === "string" ? raw.hash : null;
	} catch {
		return null;
	}
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
			return { ok: false, errors, typeCount: 0, wrote: null, diff: null, unchanged: false };
		}

		const typeCount = Object.values(manifest!.barrels).flat().length;

		let diff: BusDiff | null = null;
		if (options.diffBaseline) {
			let baselineJson: string;
			if (/^https?:\/\//.test(options.diffBaseline)) {
				const response = await fetch(options.diffBaseline, {
					signal: AbortSignal.timeout(BUS_FETCH_TIMEOUT_MS),
				});
				if (!response.ok) {
					throw new Error(
						`Failed to fetch baseline manifest from ${options.diffBaseline}: ${response.status} ${response.statusText}`,
					);
				}
				baselineJson = await response.text();
			} else {
				baselineJson = await readFile(path.resolve(cwd, options.diffBaseline), "utf8");
			}
			const baseline = parseManifest(baselineJson);
			diff = diffManifests(baseline, manifest!);
			for (const name of diff.added) logger.info(`bus: + ${name}`);
			for (const name of diff.changed) logger.info(`bus: ~ ${name}`);
			for (const name of diff.removed) logger.warn(`bus: - ${name} (removed)`);
			if (options.failOnRemoved && diff.removed.length > 0) {
				logger.error(
					`Type bus removed ${diff.removed.length} type(s) present in the baseline — failing (--fail-on-removed).`,
				);
				return { ok: false, errors: [], typeCount, wrote: null, diff, unchanged: false };
			}
		}

		if (options.check) {
			logger.done(`Type bus OK — ${typeCount} type(s), no violations.`);
			return { ok: true, errors: [], typeCount, wrote: null, diff, unchanged: false };
		}

		const outPath = path.resolve(cwd, options.out ?? "chowbea.bus.json");

		// Skip the write when the extracted content matches what is already on
		// disk. `manifest.hash` covers the barrels only — not `generatedAt` — so
		// it is stable across runs of unchanged source, mirroring the spec-side
		// cache. Without this, every watch cycle rewrote an identical file.
		if ((await readExistingHash(outPath)) === manifest!.hash) {
			logger.info(`Type bus unchanged — ${typeCount} type(s).`);
			return { ok: true, errors: [], typeCount, wrote: null, diff, unchanged: true };
		}

		await mkdir(path.dirname(outPath), { recursive: true });
		await writeFile(outPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
		logger.done(`Wrote ${typeCount} type(s) to ${outPath}`);
		return { ok: true, errors: [], typeCount, wrote: outPath, diff, unchanged: false };
	}

	if (options.watch) {
		const first = await runOnce();
		options.onCycle?.(first);
		let timer: NodeJS.Timeout | null = null;
		const { watch } = await import("node:fs");
		const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
			if (!filename || !shouldTriggerExtract(filename)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				void runOnce()
					.then((r) => options.onCycle?.(r))
					.catch((err) => logger.error(String(err)));
			}, 300);
		});
		watcher.on("error", (err) => logger.error(String(err)));
		options.registerStop?.(() => {
			if (timer) clearTimeout(timer);
			watcher.close();
		});
		// CLI path: the process stays alive on the watcher handle until SIGINT.
		return first;
	}

	return runOnce();
}
