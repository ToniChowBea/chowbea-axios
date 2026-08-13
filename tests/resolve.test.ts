import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The executeResolve tests spawn a real git repo (init/commit/branch/merge)
// plus a full generator run per test; Windows CI runners occasionally blow
// the default 5s budget under load. Issue #123.
vi.setConfig({ testTimeout: 30_000 });

import { executeResolve, partitionConflicts } from "../src/core/actions/resolve.js";
import { DEFAULT_CONFIG, generateConfigTemplate } from "../src/core/config.js";
import { listUnmergedFiles } from "../src/core/git.js";
import { makeTempGitRepo, type TempGitRepo } from "./helpers/git-repo.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

describe("partitionConflicts", () => {
	it("separates files under the generated dir from everything else", () => {
		const { generated, other } = partitionConflicts(
			[
				"api/_generated/api.operations.ts",
				"api/_generated/api.types.ts",
				"api/api.client.ts",
				"src/app.tsx",
				"api/_internal/openapi.json",
			],
			"api/_generated",
		);
		expect(generated).toEqual([
			"api/_generated/api.operations.ts",
			"api/_generated/api.types.ts",
		]);
		expect(other).toEqual([
			"api/api.client.ts",
			"src/app.tsx",
			"api/_internal/openapi.json",
		]);
	});

	it("returns empty groups when there are no conflicts", () => {
		expect(partitionConflicts([], "api/_generated")).toEqual({
			generated: [],
			other: [],
		});
	});
});

const PETSTORE_SPEC = readFileSync(
	new URL("./fixtures/petstore.json", import.meta.url),
	"utf8",
);

function scaffoldConsumer(repo: TempGitRepo): void {
	repo.write(
		"package.json",
		JSON.stringify({ name: "consumer", version: "0.0.0" }),
	);
	repo.write(
		"api.config.toml",
		generateConfigTemplate({ ...DEFAULT_CONFIG, output: { folder: "api" } }),
	);
	// Pre-seed the cached spec so `generate` works offline (no fetch).
	repo.write("api/_internal/openapi.json", PETSTORE_SPEC);
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

describe("executeResolve", () => {
	it("resolves a _generated/ conflict by regenerating from the spec and staging it", async () => {
		const repo = makeTempGitRepo();
		try {
			scaffoldConsumer(repo);
			repo.write("api/_generated/api.operations.ts", "// placeholder\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "base"]);

			repo.git(["checkout", "-b", "feature"]);
			repo.write("api/_generated/api.operations.ts", "// feature edit\n");
			repo.git(["commit", "-am", "feature"]);

			repo.git(["checkout", "main"]);
			repo.write("api/_generated/api.operations.ts", "// main edit\n");
			repo.git(["commit", "-am", "main"]);

			// Conflicting merge — leaves api.operations.ts unmerged.
			repo.tryGit(["merge", "feature"]);
			expect(listUnmergedFiles(repo.dir)).toEqual([
				"api/_generated/api.operations.ts",
			]);

			const result = await inDir(repo.dir, () =>
				executeResolve({}, SILENT_LOGGER),
			);

			expect(result.regenerated).toBe(true);
			expect(result.conflictedGenerated).toEqual([
				"api/_generated/api.operations.ts",
			]);
			expect(result.conflictedOther).toEqual([]);
			// Conflict cleared.
			expect(listUnmergedFiles(repo.dir)).toEqual([]);

			// The file was regenerated (real header, no markers, no stale edits).
			const regenerated = readFileSync(
				join(repo.dir, "api/_generated/api.operations.ts"),
				"utf8",
			);
			expect(regenerated).toContain(
				"Auto-generated API operations from OpenAPI spec",
			);
			expect(regenerated).not.toContain("<<<<<<<");
			expect(regenerated).not.toContain("placeholder");
		} finally {
			repo.cleanup();
		}
	});

	it("reports non-generated conflicts as needing manual resolution", async () => {
		const repo = makeTempGitRepo();
		try {
			scaffoldConsumer(repo);
			repo.write("src/app.tsx", "export const App = () => null;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "base"]);

			repo.git(["checkout", "-b", "feature"]);
			repo.write("src/app.tsx", "export const App = () => 1;\n");
			repo.git(["commit", "-am", "feature"]);

			repo.git(["checkout", "main"]);
			repo.write("src/app.tsx", "export const App = () => 2;\n");
			repo.git(["commit", "-am", "main"]);
			repo.tryGit(["merge", "feature"]);

			const result = await inDir(repo.dir, () =>
				executeResolve({}, SILENT_LOGGER),
			);

			expect(result.regenerated).toBe(false);
			expect(result.conflictedGenerated).toEqual([]);
			expect(result.conflictedOther).toEqual(["src/app.tsx"]);
		} finally {
			repo.cleanup();
		}
	});
});
