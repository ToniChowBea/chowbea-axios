import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeExtract } from "../src/core/actions/extract.js";
import { parseManifest } from "../src/core/bus/manifest.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

describe("executeExtract", () => {
	it("writes chowbea.bus.json to the project root by default", async () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export type Grade = "A";\n`,
		});
		try {
			const result = await executeExtract({ cwd: dir }, SILENT_LOGGER);
			expect(result.ok).toBe(true);
			expect(result.typeCount).toBe(1);
			const artifact = join(dir, "chowbea.bus.json");
			expect(result.wrote).toBe(artifact);
			const manifest = parseManifest(readFileSync(artifact, "utf8"));
			expect(Object.values(manifest.barrels).flat()[0].name).toBe("Grade");
		} finally {
			cleanup();
		}
	});

	it("--check validates without writing and fails on violations", async () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export const nope = 1;\n`,
		});
		try {
			const result = await executeExtract({ cwd: dir, check: true }, SILENT_LOGGER);
			expect(result.ok).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.wrote).toBeNull();
			expect(existsSync(join(dir, "chowbea.bus.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("clean --check passes without writing", async () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export type Grade = "A";\n`,
		});
		try {
			const result = await executeExtract({ cwd: dir, check: true }, SILENT_LOGGER);
			expect(result.ok).toBe(true);
			expect(existsSync(join(dir, "chowbea.bus.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("executeExtract --diff", () => {
	it("diffs against a baseline file and reports removals", async () => {
		const base = makeBusFixture({
			"src/bus.chowbea.ts": `export type A = 1;\nexport type B = 2;\n`,
		});
		const next = makeBusFixture({
			"src/bus.chowbea.ts": `export type A = 111;\nexport type C = 3;\n`,
		});
		try {
			const baseResult = await executeExtract({ cwd: base.dir }, SILENT_LOGGER);
			const result = await executeExtract(
				{ cwd: next.dir, diffBaseline: baseResult.wrote!, check: true },
				SILENT_LOGGER,
			);
			expect(result.ok).toBe(true); // removals are report-only without the flag
			expect(result.diff).toEqual({ added: ["C"], removed: ["B"], changed: ["A"] });
		} finally {
			base.cleanup();
			next.cleanup();
		}
	});

	it("--fail-on-removed turns removals into failure", async () => {
		const base = makeBusFixture({ "src/bus.chowbea.ts": `export type A = 1;\n` });
		const next = makeBusFixture({ "src/bus.chowbea.ts": `export type Z = 1;\n` });
		try {
			const baseResult = await executeExtract({ cwd: base.dir }, SILENT_LOGGER);
			const result = await executeExtract(
				{ cwd: next.dir, diffBaseline: baseResult.wrote!, check: true, failOnRemoved: true },
				SILENT_LOGGER,
			);
			expect(result.ok).toBe(false);
			expect(result.diff?.removed).toEqual(["A"]);
		} finally {
			base.cleanup();
			next.cleanup();
		}
	});
});

describe("executeExtract --watch", () => {
	it("re-extracts when a source file changes", async () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export type A = 1;\n`,
		});
		try {
			const cycles: number[] = [];
			let stop: (() => void) | undefined;
			const done = new Promise<void>((resolve) => {
				void executeExtract(
					{
						cwd: dir,
						watch: true,
						onCycle: (r) => {
							cycles.push(r.typeCount);
							if (cycles.length === 2) resolve();
						},
						registerStop: (s) => { stop = s; },
					},
					SILENT_LOGGER,
				);
			});
			// First cycle fires from the initial extraction; then touch a file.
			await new Promise((r) => setTimeout(r, 500));
			writeFileSync(join(dir, "src", "bus.chowbea.ts"), `export type A = 1;\nexport type B = 2;\n`);
			await done;
			expect(cycles).toEqual([1, 2]);
			stop?.();
		} finally {
			cleanup();
		}
	}, 20_000);
});
