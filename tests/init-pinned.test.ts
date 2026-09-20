import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import toml from "toml";
import { describe, expect, it } from "vitest";

import { executeInit, type PromptProvider } from "../src/core/actions/init.js";
import { DEFAULT_CONFIG, generateConfigTemplate } from "../src/core/config.js";
import { makeTempGitRepo } from "./helpers/git-repo.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

const NO_PROMPTS = {
	input: () => { throw new Error("unexpected prompt in non-interactive init"); },
	select: () => { throw new Error("unexpected prompt in non-interactive init"); },
	confirm: () => { throw new Error("unexpected prompt in non-interactive init"); },
	password: () => { throw new Error("unexpected prompt in non-interactive init"); },
} as unknown as PromptProvider;

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(orig);
	}
}

describe("init --pinned (non-interactive)", () => {
	it("scaffolds pinned config, gitignore entries, both workflows; first sync warns on dead endpoint", async () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
			const result = await inDir(repo.dir, () =>
				executeInit(
					{
						force: false, skipScripts: true, skipClient: true, skipConcurrent: true,
						skipWorkflow: false, withVitePlugins: false,
						baseUrlEnv: "API_BASE_URL", envAccessor: "import.meta.env", tokenKey: "token",
						authMode: "none", withCredentials: false, timeout: 10000,
						nonInteractive: true, pinned: true,
						specSource: { kind: "remote", endpoint: "http://127.0.0.1:1/openapi.json" },
						outputFolder: "src/api", packageManager: "npm",
					},
					SILENT_LOGGER,
					NO_PROMPTS,
				),
			);

			expect(result.pinned).toBe(true);
			expect(result.initialSyncSuccess).toBe(false); // endpoint unreachable → warned, not thrown

			const config = toml.parse(readFileSync(join(repo.dir, "api.config.toml"), "utf8")) as Record<string, unknown>;
			expect(config.api_endpoint).toBe("http://127.0.0.1:1/openapi.json");
			expect(config.spec_file).toBe("openapi.json");

			const gitignore = readFileSync(join(repo.dir, ".gitignore"), "utf8");
			expect(gitignore).toContain("_internal/");
			expect(gitignore).toContain("_generated/");
			expect(gitignore).toContain("api.config.local.toml");

			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-sync.yml"))).toBe(true);
			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-pinned-ci.yml"))).toBe(true);
			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-axios-ci.yml"))).toBe(false);
		} finally {
			repo.cleanup();
		}
	}, 10_000);

	// Pins the `options.pinned ?? (...)` resolution boundary in executeInit:
	// omitting `pinned` entirely (as the CLI now forwards `values.pinned` raw,
	// undefined when --pinned is absent) must resolve to `false` WITHOUT
	// prompting when non-interactive — never treat "unset" as "ask anyway".
	it("with pinned omitted + non-interactive, resolves to unpinned without prompting", async () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
			const result = await inDir(repo.dir, () =>
				executeInit(
					{
						force: false, skipScripts: true, skipClient: true, skipConcurrent: true,
						skipWorkflow: true, withVitePlugins: false,
						baseUrlEnv: "API_BASE_URL", envAccessor: "import.meta.env", tokenKey: "token",
						authMode: "none", withCredentials: false, timeout: 10000,
						nonInteractive: true, // `pinned` deliberately omitted — undefined, not false
						specSource: { kind: "remote", endpoint: "http://127.0.0.1:1/openapi.json" },
						outputFolder: "src/api", packageManager: "npm",
					},
					SILENT_LOGGER,
					NO_PROMPTS, // must not throw: proves no prompt fired for the unset flag
				),
			);

			expect(result.pinned).toBe(false);
			expect(result.initialSyncSuccess).toBe(null); // pinned branch never entered
			expect(result.initialFetchSuccess).toBe(null); // localhost endpoint — fetch skipped too (fast/offline)
			expect(result.workflowCreated).toBe(false); // skipWorkflow: true

			const config = toml.parse(readFileSync(join(repo.dir, "api.config.toml"), "utf8")) as Record<string, unknown>;
			expect(config.api_endpoint).toBe("http://127.0.0.1:1/openapi.json");
			expect(config.spec_file).toBeUndefined(); // pinned emission did not fire

			const gitignore = readFileSync(join(repo.dir, ".gitignore"), "utf8");
			expect(gitignore).toContain("_internal/");
			expect(gitignore).not.toContain("_generated/");
		} finally {
			repo.cleanup();
		}
	});

	// Regression (PR #143 review): when an existing config's overwrite is
	// declined, every later step must follow the PERSISTED config's mode, not
	// the wizard's requested one — otherwise `init --pinned` over a non-pinned
	// config scaffolds pinned workflows/gitignore for a repo whose config
	// stayed non-pinned.
	it("overwrite declined: later steps use the persisted config's mode, not the requested pinned", async () => {
		const repo = makeTempGitRepo();
		try {
			repo.write("package.json", JSON.stringify({ name: "consumer", version: "0.0.0" }));
			repo.write(
				"api.config.toml",
				generateConfigTemplate({ ...DEFAULT_CONFIG, output: { folder: "src/api" } }), // non-pinned (localhost endpoint, no spec_file)
			);
			// Scripted prompts: decline the overwrite, take defaults elsewhere.
			const DECLINE_OVERWRITE = {
				input: (opts: { default?: string }) => Promise.resolve(opts.default ?? "src/api"),
				select: (opts: { default?: unknown; choices: Array<{ value: unknown }> }) =>
					Promise.resolve(opts.default ?? opts.choices[0]?.value),
				confirm: (opts: { message: string; default?: boolean }) =>
					Promise.resolve(opts.message.includes("Overwrite") ? false : opts.default ?? false),
				password: () => Promise.resolve(""),
			} as unknown as PromptProvider;

			const result = await inDir(repo.dir, () =>
				executeInit(
					{
						force: false, skipScripts: true, skipClient: true, skipConcurrent: true,
						skipWorkflow: false, withVitePlugins: false,
						baseUrlEnv: "API_BASE_URL", envAccessor: "import.meta.env", tokenKey: "token",
						authMode: "none", withCredentials: false, timeout: 10000,
						pinned: true, // requested, but the persisted config wins after the decline
						specSource: { kind: "remote", endpoint: "http://127.0.0.1:1/openapi.json" },
						outputFolder: "src/api", packageManager: "npm",
					},
					SILENT_LOGGER,
					DECLINE_OVERWRITE,
				),
			);

			expect(result.pinned).toBe(false);
			expect(result.initialSyncSuccess).toBe(null); // pinned branch never entered

			// Config on disk is untouched and still non-pinned.
			const config = toml.parse(readFileSync(join(repo.dir, "api.config.toml"), "utf8")) as Record<string, unknown>;
			expect(config.spec_file).toBeUndefined();

			// Workflow selection followed the persisted mode: classic CI, not the pinned pair.
			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-axios-ci.yml"))).toBe(true);
			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-sync.yml"))).toBe(false);
			expect(existsSync(join(repo.dir, ".github/workflows/chowbea-pinned-ci.yml"))).toBe(false);

			// Gitignore followed the persisted mode too.
			const gitignore = readFileSync(join(repo.dir, ".gitignore"), "utf8");
			expect(gitignore).not.toContain("_generated/");
		} finally {
			repo.cleanup();
		}
	});
});
