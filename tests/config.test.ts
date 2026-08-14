import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toml from "toml";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_CONFIG,
	DEFAULT_INSTANCE_CONFIG,
	generateConfigTemplate,
	getOutputPaths,
	loadConfig,
} from "../src/core/config.js";
import { ConfigValidationError } from "../src/core/errors.js";

describe("DEFAULT_INSTANCE_CONFIG (#28)", () => {
	it("with_credentials defaults to false (cookies are opt-in)", () => {
		expect(DEFAULT_INSTANCE_CONFIG.with_credentials).toBe(false);
	});
});

describe("generateConfigTemplate (#27 — TOML escaping)", () => {
	it("round-trips quotes, backslashes, and control chars in string fields", () => {
		const config = {
			...DEFAULT_CONFIG,
			api_endpoint: 'https://api.example.com/path?q="hello"&x=\\\\',
			output: { folder: 'src/api with "quotes"' },
			instance: {
				...DEFAULT_INSTANCE_CONFIG,
				token_key: 'tok"en\\back',
				base_url_env: "API_BASE_URL",
				env_accessor: "process.env",
			},
		};
		const tomlText = generateConfigTemplate(config);
		// The output must parse cleanly (i.e. the special chars are escaped).
		const parsed = toml.parse(tomlText) as Record<string, unknown>;
		expect(parsed.api_endpoint).toBe(config.api_endpoint);
		expect((parsed.output as Record<string, unknown>).folder).toBe(
			config.output.folder,
		);
		const inst = parsed.instance as Record<string, unknown>;
		expect(inst.token_key).toBe(config.instance.token_key);
	});

	it("never produces broken TOML even when token_key contains injection-style payloads", () => {
		const config = {
			...DEFAULT_CONFIG,
			instance: {
				...DEFAULT_INSTANCE_CONFIG,
				token_key: 'foo"\nmalicious_key = "x',
			},
		};
		const tomlText = generateConfigTemplate(config);
		// Parse must succeed.
		const parsed = toml.parse(tomlText);
		// And the malicious "second key" payload must NOT have created a
		// new top-level entry — the literal string is preserved, not split.
		expect(
			(parsed as { malicious_key?: unknown }).malicious_key,
		).toBeUndefined();
		const inst = (parsed as { instance: Record<string, unknown> }).instance;
		expect(inst.token_key).toBe('foo"\nmalicious_key = "x');
	});
});

describe("loadConfig (#39 — no auto-create without opt-in)", () => {
	async function withTempProject<T>(
		fn: (root: string, configPath: string) => Promise<T>,
	): Promise<T> {
		const root = join(
			tmpdir(),
			`chowbea-loadconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "test", version: "0.0.0" }),
			"utf8",
		);
		const configPath = join(root, "api.config.toml");
		try {
			return await fn(root, configPath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it("throws ConfigError when the file is missing and autoCreate is not set", async () => {
		await withTempProject(async (_root, configPath) => {
			await expect(loadConfig(configPath)).rejects.toThrow(
				/No api\.config\.toml found/,
			);
		});
	});

	it("error message points the user at `chowbea-axios init`", async () => {
		await withTempProject(async (_root, configPath) => {
			try {
				await loadConfig(configPath);
				expect.unreachable();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				expect(msg).toMatch(/No api\.config\.toml/);
				// `recoveryHint` is on the ChowbeaAxiosError instance.
				const hint = (err as { recoveryHint?: string }).recoveryHint;
				expect(hint).toMatch(/chowbea-axios init/);
			}
		});
	});

	it("creates the config when autoCreate is explicitly true (init's path)", async () => {
		await withTempProject(async (_root, configPath) => {
			const result = await loadConfig(configPath, { autoCreate: true });
			expect(result.wasCreated).toBe(true);
			// The returned config matches DEFAULT_CONFIG.
			expect(result.config.poll_interval_ms).toBe(
				DEFAULT_CONFIG.poll_interval_ms,
			);
			// And the file exists on disk now.
			const re = await loadConfig(configPath);
			expect(re.wasCreated).toBe(false);
		});
	});
});

describe("[bus] config", () => {
	async function withTempProject<T>(
		fn: (root: string, configPath: string) => Promise<T>,
	): Promise<T> {
		const root = join(
			tmpdir(),
			`chowbea-bus-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "test", version: "0.0.0" }),
			"utf8",
		);
		const configPath = join(root, "api.config.toml");
		try {
			return await fn(root, configPath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const MINIMAL_CONFIG = `api_endpoint = "https://api.example.com/openapi.json"
poll_interval_ms = 10000

[output]
folder = "src/api"
`;

	it("absent bus section parses as undefined (feature inert)", async () => {
		await withTempProject(async (_root, configPath) => {
			await writeFile(configPath, MINIMAL_CONFIG, "utf8");
			const result = await loadConfig(configPath);
			expect(result.config.bus).toBeUndefined();
		});
	});

	it("valid [bus] endpoint parses", async () => {
		await withTempProject(async (_root, configPath) => {
			await writeFile(
				configPath,
				`${MINIMAL_CONFIG}
[bus]
endpoint = "https://staging.example.com/.well-known/chowbea.json"
`,
				"utf8",
			);
			const result = await loadConfig(configPath);
			expect(result.config.bus).toEqual({
				endpoint: "https://staging.example.com/.well-known/chowbea.json",
			});
		});
	});

	it("[bus] without endpoint throws ConfigValidationError naming bus.endpoint", async () => {
		await withTempProject(async (_root, configPath) => {
			await writeFile(
				configPath,
				`${MINIMAL_CONFIG}
[bus]
`,
				"utf8",
			);
			try {
				await loadConfig(configPath);
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(ConfigValidationError);
				expect((err as ConfigValidationError).field).toBe("bus.endpoint");
			}
		});
	});

	it("getOutputPaths exposes busDir under _generated and busCache under _internal", () => {
		const paths = getOutputPaths(DEFAULT_CONFIG, "/tmp/x");
		expect(paths.busDir.endsWith(join("_generated", "bus"))).toBe(true);
		expect(paths.busCache.endsWith(join("_internal", "chowbea.bus.json"))).toBe(
			true,
		);
	});
});
