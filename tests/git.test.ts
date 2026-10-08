import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	isGitRepo,
	listTrackedFiles,
	listUnmergedFiles,
	removeFromIndex,
	stageFiles,
} from "../src/core/git.js";
import { makeTempGitRepo } from "./helpers/git-repo.js";

describe("git helpers", () => {
	it("isGitRepo is true inside a repo and false outside one", () => {
		const repo = makeTempGitRepo();
		const notRepo = mkdtempSync(join(tmpdir(), "chowbea-notrepo-"));
		try {
			expect(isGitRepo(repo.dir)).toBe(true);
			expect(isGitRepo(notRepo)).toBe(false);
		} finally {
			repo.cleanup();
			rmSync(notRepo, { recursive: true, force: true });
		}
	});

	it("listTrackedFiles returns only files tracked under the given path", () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("_internal/.api-cache.json", "{}");
			repo.write("_internal/openapi.json", "{}");
			repo.write("src/app.ts", "export const x = 1;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init"]);

			expect(listTrackedFiles(repo.dir, "_internal").sort()).toEqual([
				"_internal/.api-cache.json",
				"_internal/openapi.json",
			]);
		} finally {
			repo.cleanup();
		}
	});

	it("listTrackedFiles returns [] when nothing is tracked under the path", () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("src/app.ts", "export const x = 1;\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init"]);

			expect(listTrackedFiles(repo.dir, "_internal")).toEqual([]);
		} finally {
			repo.cleanup();
		}
	});

	it("removeFromIndex untracks a path but leaves the files on disk", () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("_internal/openapi.json", "{}");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "init"]);

			removeFromIndex(repo.dir, ["_internal"]);

			expect(listTrackedFiles(repo.dir, "_internal")).toEqual([]);
			expect(existsSync(join(repo.dir, "_internal/openapi.json"))).toBe(true);
		} finally {
			repo.cleanup();
		}
	}, 30_000);

	it("listUnmergedFiles lists files with merge conflicts (and [] when clean)", () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("a.txt", "base\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "base"]);
			expect(listUnmergedFiles(repo.dir)).toEqual([]);

			repo.git(["checkout", "-b", "feature"]);
			repo.write("a.txt", "feature side\n");
			repo.git(["commit", "-am", "feature"]);

			repo.git(["checkout", "main"]);
			repo.write("a.txt", "main side\n");
			repo.git(["commit", "-am", "main"]);

			// Conflicting merge — exits non-zero, which is expected.
			repo.tryGit(["merge", "feature"]);

			expect(listUnmergedFiles(repo.dir)).toEqual(["a.txt"]);
		} finally {
			repo.cleanup();
		}
	}, 30_000);

	it("stageFiles adds previously-conflicted content to the index", () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("a.txt", "base\n");
			repo.git(["add", "."]);
			repo.git(["commit", "-m", "base"]);

			repo.git(["checkout", "-b", "feature"]);
			repo.write("a.txt", "feature side\n");
			repo.git(["commit", "-am", "feature"]);

			repo.git(["checkout", "main"]);
			repo.write("a.txt", "main side\n");
			repo.git(["commit", "-am", "main"]);
			repo.tryGit(["merge", "feature"]);

			// Resolve by overwriting, then stage via the helper.
			repo.write("a.txt", "resolved\n");
			stageFiles(repo.dir, ["a.txt"]);

			expect(listUnmergedFiles(repo.dir)).toEqual([]);
		} finally {
			repo.cleanup();
		}
	}, 30_000);
});
