import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeDoctor } from "../src/core/actions/doctor.js";
import { DEFAULT_CONFIG, generateConfigTemplate } from "../src/core/config.js";
import { listTrackedFiles } from "../src/core/git.js";
import { makeTempGitRepo, type TempGitRepo } from "./helpers/git-repo.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

/** Scaffold a consumer project (package.json + api.config.toml) in the repo. */
function scaffoldProject(repo: TempGitRepo, outputFolder = "api"): void {
	repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
	repo.write(
		"api.config.toml",
		generateConfigTemplate({ ...DEFAULT_CONFIG, output: { folder: outputFolder } }),
	);
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

describe("executeDoctor", () => {
	it("--fix untracks committed _internal/ artifacts and adds the gitignore rule", async () => {
		const repo = makeTempGitRepo();
		try {
			scaffoldProject(repo);
			repo.write("api/_internal/.api-cache.json", '{"hash":"x"}');
			repo.write("api/_internal/openapi.json", "{}");
			repo.write("api/_generated/api.operations.ts", "export const x = 1;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init with committed _internal"]);

			const result = await inDir(repo.dir, () =>
				executeDoctor({ fix: true }, SILENT_LOGGER),
			);

			expect(result.trackedArtifacts.length).toBeGreaterThan(0);
			expect(result.fixApplied).toBe(true);
			// _internal/ is no longer tracked, but the files remain on disk.
			expect(listTrackedFiles(repo.dir, "api/_internal")).toEqual([]);
			expect(existsSync(join(repo.dir, "api/_internal/openapi.json"))).toBe(true);
			// The ignore rule is present going forward.
			expect(readFileSync(join(repo.dir, ".gitignore"), "utf8")).toContain(
				"_internal/",
			);
		} finally {
			repo.cleanup();
		}
	});

	it("report-only (no --fix) detects the problem without mutating anything", async () => {
		const repo = makeTempGitRepo();
		try {
			scaffoldProject(repo);
			repo.write("api/_internal/openapi.json", "{}");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init"]);

			const result = await inDir(repo.dir, () =>
				executeDoctor({ fix: false }, SILENT_LOGGER),
			);

			expect(result.trackedArtifacts.length).toBeGreaterThan(0);
			expect(result.fixApplied).toBe(false);
			// Still tracked — nothing was changed.
			expect(listTrackedFiles(repo.dir, "api/_internal")).not.toEqual([]);
			expect(existsSync(join(repo.dir, ".gitignore"))).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	it("reports a clean bill of health when _internal/ is already ignored", async () => {
		const repo = makeTempGitRepo();
		try {
			scaffoldProject(repo);
			repo.write(".gitignore", "_internal/\n");
			repo.write("api/_internal/openapi.json", "{}"); // present but ignored
			repo.write("api/_generated/api.operations.ts", "export const x = 1;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init clean"]);

			const result = await inDir(repo.dir, () =>
				executeDoctor({ fix: true }, SILENT_LOGGER),
			);

			expect(result.healthy).toBe(true);
			expect(result.trackedArtifacts).toEqual([]);
			expect(result.hasIgnoreRule).toBe(true);
			expect(result.fixApplied).toBe(false);
		} finally {
			repo.cleanup();
		}
	});

	it("pinned mode: tracked _generated files are reported and --fix untracks + ignores them", async () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
			repo.write(
				"api.config.toml",
				generateConfigTemplate({
					...DEFAULT_CONFIG,
					api_endpoint: "https://staging.example.com/openapi.json",
					spec_file: "openapi.json",
					output: { folder: "api" },
				}),
			);
			repo.write("api/_generated/api.types.ts", "export type X = 1;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init with committed _generated"]);

			const result = await inDir(repo.dir, () => executeDoctor({ fix: true }, SILENT_LOGGER));

			expect(result.trackedArtifacts).toContain("api/_generated/api.types.ts");
			expect(result.fixApplied).toBe(true);
			expect(listTrackedFiles(repo.dir, "api/_generated")).toEqual([]);
			expect(existsSync(join(repo.dir, "api/_generated/api.types.ts"))).toBe(true);
			expect(readFileSync(join(repo.dir, ".gitignore"), "utf8")).toContain("_generated/");
		} finally {
			repo.cleanup();
		}
	});
});
