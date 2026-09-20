# Pinned API Inputs & Team CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in pinned-inputs mode: commit `openapi.json` + `chowbea.bus.json` as the client repo's type source of truth, gitignore all generated output, add a `sync` command (the only pin writer), a per-dev `api.config.local.toml` overlay, and CI templates for dispatch-driven sync PRs.

**Architecture:** Pinned mode is the presence of config keys (`spec_file` + `api_endpoint`, `[bus].file`), not a flag. `generate` prefers pinned files (offline); `fetch`/`watch` prefer live endpoints (dev loop); `sync` reads the committed config only, fetches from the stable endpoint, validates, writes pins on change, and regenerates.

**Tech Stack:** Node >=20, TypeScript, vitest, `toml` (parse), `yaml` (template test), node:http fixture servers. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-pinned-inputs-cicd-design.md`

## Global Constraints

- Node `>=20` (`engines`); ESM; all imports end in `.js`.
- No new runtime or dev dependencies.
- `src/core/config.ts` uses 2-space indentation; `src/core/actions/*`, `src/headless/runner.ts`, and tests use tabs. Match the file you edit.
- TDD: every behavior lands with a failing test first. Test commands: `npx vitest run <file>`; full gate: `npm test && npx tsc --noEmit`.
- Conventional commits, one commit per task, `--no-verify` not needed (no hooks).
- Headless surface only — no TUI screens.
- Existing non-pinned setups must pass the whole suite unchanged except where a task explicitly documents a behavior change (Task 4).

---

### Task 1: Config — `[bus].file` key + template emits `[bus]` and dual spec sources

**Files:**
- Modify: `src/core/config.ts` (`BusConfig` ~line 38, `validateBusConfig` ~line 499, `generateConfigTemplate` ~line 160)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: existing `BusConfig`, `generateConfigTemplate(config: ApiConfig): string`.
- Produces: `BusConfig { endpoint: string; file?: string }`; `generateConfigTemplate` emits an active `[bus]` block when `config.bus` is set, and emits BOTH `api_endpoint` and `spec_file` uncommented when both are set (pinned mode); also exports `isPinnedMode(config: ApiConfig): boolean` (true when both `api_endpoint` and `spec_file` are set). Tasks 3, 5, 8, 9 rely on these exact names.

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`:

```ts
describe("BusConfig.file (pinned manifest)", () => {
	it("accepts an optional non-empty file and rejects an empty one", async () => {
		const dir = join(tmpdir(), `chowbea-cfg-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		const base = `api_endpoint = "https://x.example/openapi.json"\npoll_interval_ms = 5000\n[output]\nfolder = "src/api"\n`;
		await writeFile(join(dir, "api.config.toml"), `${base}[bus]\nendpoint = "https://x.example/bus.json"\nfile = "chowbea.bus.json"\n`, "utf8");
		const { config } = await loadConfig(join(dir, "api.config.toml"));
		expect(config.bus).toEqual({ endpoint: "https://x.example/bus.json", file: "chowbea.bus.json" });

		await writeFile(join(dir, "api.config.toml"), `${base}[bus]\nendpoint = "https://x.example/bus.json"\nfile = ""\n`, "utf8");
		await expect(loadConfig(join(dir, "api.config.toml"))).rejects.toThrow(/bus\.file/);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("generateConfigTemplate: pinned mode + [bus]", () => {
	it("emits both spec sources uncommented when both are set, plus the [bus] block", () => {
		const config = {
			...DEFAULT_CONFIG,
			api_endpoint: "https://staging.example.com/openapi.json",
			spec_file: "openapi.json",
			bus: { endpoint: "https://staging.example.com/bus.json", file: "chowbea.bus.json" },
		};
		const parsed = toml.parse(generateConfigTemplate(config)) as Record<string, unknown>;
		expect(parsed.api_endpoint).toBe(config.api_endpoint);
		expect(parsed.spec_file).toBe("openapi.json");
		expect(parsed.bus).toEqual({ endpoint: config.bus.endpoint, file: "chowbea.bus.json" });
	});
	it("isPinnedMode is true only when api_endpoint and spec_file are both set", () => {
		expect(isPinnedMode({ ...DEFAULT_CONFIG, api_endpoint: "https://x", spec_file: "openapi.json" })).toBe(true);
		expect(isPinnedMode(DEFAULT_CONFIG)).toBe(false);
	});
});
```

Add `isPinnedMode` to the existing import list from `../src/core/config.js`, and `rm`/`writeFile`/`mkdir` from `node:fs/promises` if missing.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/config.test.ts` → FAIL (`file` dropped by validator, no `[bus]` in template, `isPinnedMode` not exported).

- [ ] **Step 3: Implement** in `src/core/config.ts` (2-space indent):

In `BusConfig`:

```ts
export interface BusConfig {
  /** URL of the served chowbea.bus.json (conventionally /.well-known/chowbea.json). */
  endpoint: string;
  /** Repo-relative path of the pinned (committed) manifest. Enables pinned mode for the bus. */
  file?: string;
}
```

In `validateBusConfig`, before `return { endpoint: busObj.endpoint };`:

```ts
  let file: string | undefined;
  if (busObj.file !== undefined) {
    if (typeof busObj.file !== "string" || busObj.file.trim() === "") {
      throw new ConfigValidationError(
        "bus.file",
        "bus.file must be a non-empty string path (the committed manifest, e.g. \"chowbea.bus.json\")"
      );
    }
    file = busObj.file;
  }

  return file ? { endpoint: busObj.endpoint, file } : { endpoint: busObj.endpoint };
```

In `generateConfigTemplate`, replace the `specSourceBlock` ternary with a three-way (both → pinned emission) and add a `busBlock`:

```ts
  const specSourceBlock =
    config.spec_file && config.api_endpoint
      ? `api_endpoint = ${tomlEscape(config.api_endpoint)}
spec_file = ${tomlEscape(config.spec_file)}  # pinned spec, committed — updated by \`chowbea-axios sync\``
      : config.spec_file
        ? `# api_endpoint = ${tomlEscape(fallbackEndpoint)}  # Use remote endpoint instead of local file
spec_file = ${tomlEscape(config.spec_file)}`
        : `api_endpoint = ${tomlEscape(config.api_endpoint ?? "")}
# spec_file = "./openapi.json"  # Use local file instead of remote`;

  const busBlock = config.bus
    ? `
[bus]
endpoint = ${tomlEscape(config.bus.endpoint)}${config.bus.file ? `\nfile = ${tomlEscape(config.bus.file)}` : ""}
`
    : "";
```

Append `${busBlock}` into the returned template string immediately after the `[output]` block (before `[instance]`). Then add near `resolveSpecSource`:

```ts
/**
 * Pinned-inputs mode: both the stable endpoint (sync source) and the
 * committed spec path are configured. See the 2026-09-20 design spec.
 */
export function isPinnedMode(config: ApiConfig): boolean {
  return Boolean(config.api_endpoint && config.spec_file);
}
```

- [ ] **Step 4: Run** `npx vitest run tests/config.test.ts` → PASS; then `npm test && npx tsc --noEmit` → all green.
- [ ] **Step 5: Commit** — `git add src/core/config.ts tests/config.test.ts && git commit -m "feat(config): [bus].file pinned-manifest key, pinned template emission, isPinnedMode"`

---

### Task 2: Config — `api.config.local.toml` overlay

**Files:**
- Modify: `src/core/config.ts` (`LoadConfigOptions` ~line 566, `loadConfig` ~line 585)
- Modify: `src/core/actions/generate.ts` (~line 79), `src/core/actions/fetch.ts` (its `loadConfig` call), `src/core/actions/watch.ts` (its `loadConfig` call) — one log line each
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `LoadConfigOptions.localOverlay?: boolean` (default `true`); `loadConfig` return gains `localOverrides: string[]` (dotted keys, empty when none/disabled) and `localOverridePresent: boolean`. Task 5 calls `loadConfig(path, { localOverlay: false })`.

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`:

```ts
describe("api.config.local.toml overlay", () => {
	async function overlayFixture(committed: string, local?: string) {
		const dir = join(tmpdir(), `chowbea-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), "{}", "utf8");
		await writeFile(join(dir, "api.config.toml"), committed, "utf8");
		if (local !== undefined) await writeFile(join(dir, "api.config.local.toml"), local, "utf8");
		return dir;
	}
	const COMMITTED = `api_endpoint = "https://staging.example.com/openapi.json"\nspec_file = "openapi.json"\npoll_interval_ms = 5000\n[output]\nfolder = "src/api"\n[bus]\nendpoint = "https://staging.example.com/bus.json"\nfile = "chowbea.bus.json"\n`;

	it("merges field-level, local wins, nested tables merge per key", async () => {
		const dir = await overlayFixture(COMMITTED, `api_endpoint = "https://tunnel.example/openapi.json"\n[bus]\nendpoint = "https://tunnel.example/bus.json"\n`);
		const { config, localOverrides, localOverridePresent } = await loadConfig(join(dir, "api.config.toml"));
		expect(config.api_endpoint).toBe("https://tunnel.example/openapi.json");
		expect(config.bus).toEqual({ endpoint: "https://tunnel.example/bus.json", file: "chowbea.bus.json" }); // file kept from committed
		expect(localOverridePresent).toBe(true);
		expect(localOverrides.sort()).toEqual(["api_endpoint", "bus.endpoint"]);
		await rm(dir, { recursive: true, force: true });
	});

	it("localOverlay: false ignores the local file but still reports its presence", async () => {
		const dir = await overlayFixture(COMMITTED, `api_endpoint = "https://tunnel.example/openapi.json"\n`);
		const { config, localOverrides, localOverridePresent } = await loadConfig(join(dir, "api.config.toml"), { localOverlay: false });
		expect(config.api_endpoint).toBe("https://staging.example.com/openapi.json");
		expect(localOverrides).toEqual([]);
		expect(localOverridePresent).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	it("no local file → empty overrides, not present", async () => {
		const dir = await overlayFixture(COMMITTED);
		const { localOverrides, localOverridePresent } = await loadConfig(join(dir, "api.config.toml"));
		expect(localOverrides).toEqual([]);
		expect(localOverridePresent).toBe(false);
		await rm(dir, { recursive: true, force: true });
	});

	it("a malformed local file fails loudly (never silently ignored)", async () => {
		const dir = await overlayFixture(COMMITTED, `api_endpoint = not valid toml`);
		await expect(loadConfig(join(dir, "api.config.toml"))).rejects.toThrow(/api\.config\.local\.toml/);
		await rm(dir, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/config.test.ts` → FAIL (`localOverrides` undefined).

- [ ] **Step 3: Implement** in `src/core/config.ts`. Extend `LoadConfigOptions`:

```ts
  /**
   * Merge a sibling api.config.local.toml (gitignored, per-dev endpoints/
   * auth) over the committed config. Defaults to true. `sync` passes false:
   * the pinned files must only ever be produced from the committed truth.
   */
  localOverlay?: boolean;
```

Add helpers above `loadConfig`:

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field-level merge, local wins; nested tables merge per key; scalars and
 * arrays replace. `overridden` collects dotted leaf keys for visibility
 * logging ("local overrides: api_endpoint, bus.endpoint").
 */
function mergeLocalConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  prefix: string,
  overridden: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeLocalConfig(out[key] as Record<string, unknown>, value, dotted, overridden);
    } else {
      out[key] = value;
      overridden.push(dotted);
    }
  }
  return out;
}

function localConfigPath(configPath: string): string {
  return configPath.endsWith(".toml")
    ? `${configPath.slice(0, -5)}.local.toml`
    : `${configPath}.local`;
}
```

In `loadConfig`: change the return type to include `localOverrides: string[]; localOverridePresent: boolean` (the auto-create branch returns `localOverrides: [], localOverridePresent: false`). In the existing-config branch, after `const parsed = toml.parse(content);` and before `validateConfig`:

```ts
    const localPath = localConfigPath(resolvedConfigPath);
    const localExists = await configExists(localPath);
    const localOverrides: string[] = [];
    let merged = parsed as Record<string, unknown>;
    if (localExists && (options.localOverlay ?? true)) {
      let localParsed: unknown;
      try {
        localParsed = toml.parse(await readFile(localPath, "utf8"));
      } catch (error) {
        throw new ConfigError(
          `Failed to parse api.config.local.toml: ${error instanceof Error ? error.message : String(error)}`,
          "Fix or delete the local override file.",
        );
      }
      merged = mergeLocalConfig(merged, localParsed as Record<string, unknown>, "", localOverrides);
    }
    const config = validateConfig(merged);

    return {
      config,
      projectRoot,
      configPath: resolvedConfigPath,
      wasCreated: false,
      localOverrides,
      localOverridePresent: localExists,
    };
```

- [ ] **Step 4: Run** `npx vitest run tests/config.test.ts` → PASS. Then `npx tsc --noEmit` (return-type change is additive, existing destructurings unaffected).

- [ ] **Step 5: Wire visibility logging.** In `src/core/actions/generate.ts` (~line 79), `src/core/actions/fetch.ts`, and `src/core/actions/watch.ts` (find each `await loadConfig(` call site), add `localOverrides` to the destructure and immediately after it:

```ts
	if (localOverrides.length > 0) {
		logger.info({ overrides: localOverrides }, "Using api.config.local.toml overrides");
	}
```

- [ ] **Step 6: Run** `npm test && npx tsc --noEmit` → all green.
- [ ] **Step 7: Commit** — `git add src/core/config.ts src/core/actions/generate.ts src/core/actions/fetch.ts src/core/actions/watch.ts tests/config.test.ts && git commit -m "feat(config): api.config.local.toml per-dev overlay with field-level merge"`

---

### Task 3: `generate` — bus emission from the pinned manifest

**Files:**
- Modify: `src/core/actions/generate.ts` (the `if (config.bus)` block, ~lines 208–230)
- Test: `tests/bus-generate-action.test.ts`

**Interfaces:**
- Consumes: `BusConfig.file` (Task 1), `parseManifest`, `writeBusFiles`.
- Produces: pinned-file emission behavior Task 5's regeneration relies on conceptually (no new exports).

- [ ] **Step 1: Write failing tests** in `tests/bus-generate-action.test.ts` (reuse the file's existing `makeBusFixture`/`inDir`/`generateConfigTemplate` pattern and `PETSTORE_SPEC`):

```ts
describe("executeGenerate: pinned bus manifest ([bus].file)", () => {
	const pinnedConfig = () => ({
		...DEFAULT_CONFIG,
		api_endpoint: "https://staging.example.invalid/openapi.json",
		spec_file: "./openapi.json",
		output: { folder: "api" },
		bus: { endpoint: "https://staging.example.invalid/bus.json", file: "chowbea.bus.json" },
	});

	it("emits _generated/bus from the pinned file and ignores the _internal cache", async () => {
		const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
		const stale = buildManifest({ core: [entry("Old", "export type Old = 1;")] });
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
			"chowbea.bus.json": `${JSON.stringify(manifest, null, "\t")}\n`,
		});
		try {
			const config = pinnedConfig();
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(config), "utf8");
			const outputPaths = getOutputPaths(config, dir);
			mkdirSync(dirname(outputPaths.busCache), { recursive: true });
			writeFileSync(outputPaths.busCache, `${JSON.stringify(stale, null, "\t")}\n`, "utf8");

			await inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER));
			const emitted = readFileSync(join(outputPaths.busDir, "core.ts"), "utf8");
			expect(emitted).toContain("Grade");
			expect(emitted).not.toContain("Old");
		} finally {
			cleanup();
		}
	});

	it("missing pinned file fails with an actionable 'run sync' error", async () => {
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
		});
		try {
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(pinnedConfig()), "utf8");
			await expect(inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER))).rejects.toThrow(
				/pinned bus manifest not found.*chowbea-axios sync/s,
			);
		} finally {
			cleanup();
		}
	});

	it("a tampered pinned manifest fails loudly (hash integrity)", async () => {
		const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
		const tampered = JSON.stringify({ ...manifest, hash: "0".repeat(64) });
		const { dir, cleanup } = makeBusFixture({
			"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
			"openapi.json": PETSTORE_SPEC,
			"chowbea.bus.json": tampered,
		});
		try {
			writeFileSync(join(dir, "api.config.toml"), generateConfigTemplate(pinnedConfig()), "utf8");
			await expect(inDir(dir, () => executeGenerate(generateOptions, SILENT_LOGGER))).rejects.toThrow(
				/hash does not match/,
			);
		} finally {
			cleanup();
		}
	});
});
```

Add the `entry` helper if the file lacks one (copy from `tests/bus-fetch.test.ts`):

```ts
function entry(name: string, declaration: string, source = "src/types.chowbea.ts") {
	return { name, kind: "type" as const, declaration, source, line: 1, hash: hashText(declaration) };
}
```

with `import { buildManifest, hashText } from "../src/core/bus/manifest.js";`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/bus-generate-action.test.ts` → FAIL (emission still comes from cache).

- [ ] **Step 3: Implement** in `src/core/actions/generate.ts`. Replace the body of the `if (config.bus)` block with:

```ts
	if (config.bus) {
		const { readFile } = await import("node:fs/promises");
		const path = await import("node:path");
		const { parseManifest } = await import("../bus/manifest.js");
		const { writeBusFiles } = await import("../bus/emit.js");

		if (config.bus.file) {
			// Pinned mode: the committed manifest is the source of truth; the
			// _internal cache is not consulted. parseManifest is the trust
			// boundary — a tampered pinned file fails its hash check here.
			const pinnedPath = path.resolve(projectRoot, config.bus.file);
			let pinned: string;
			try {
				pinned = await readFile(pinnedPath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				throw new Error(
					`pinned bus manifest not found at ${pinnedPath} — run \`chowbea-axios sync\` to create it`,
				);
			}
			const manifest = parseManifest(pinned);
			await writeBusFiles(manifest, outputPaths.busDir);
			logger.info("Type bus: regenerated from pinned manifest");
		} else {
			// Only an absent cache file is the expected "never ran fetch" case —
			// swallow that one as a warning. A cache file that exists but fails to
			// parse/validate, or an emission failure (e.g. filename collision),
			// is a real problem and must fail generate loudly, same as any other
			// failure in this action (e.g. SpecNotFoundError above).
			let cached: string | null = null;
			try {
				cached = await readFile(outputPaths.busCache, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				logger.warn("Type bus configured but no cached manifest — run fetch first");
			}
			if (cached !== null) {
				const manifest = parseManifest(cached);
				await writeBusFiles(manifest, outputPaths.busDir);
				logger.info("Type bus: regenerated from cache");
			}
		}
	}
```

- [ ] **Step 4: Run** `npx vitest run tests/bus-generate-action.test.ts` → PASS; `npm test` → green.
- [ ] **Step 5: Commit** — `git add src/core/actions/generate.ts tests/bus-generate-action.test.ts && git commit -m "feat(generate): emit type bus from pinned [bus].file manifest"`

---

### Task 4: `fetch`/`watch` — live sources prefer endpoints over `spec_file`

**Files:**
- Modify: `src/core/config.ts` (new `resolveLiveSpecSource` next to `resolveSpecSource`)
- Modify: `src/core/actions/fetch.ts` (~lines 216–222), `src/core/actions/watch.ts` (its `resolveSpecSource` call)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `resolveLiveSpecSource(config: ApiConfig, projectRoot: string, flags?: { endpoint?: string; specFile?: string }): SpecSource` — priority: `flags.endpoint` > `flags.specFile` > `config.api_endpoint` > `config.spec_file`. `generate`/`diff`/`validate` keep `resolveSpecSource` (pinned file wins) — do not touch them.

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`:

```ts
describe("resolveLiveSpecSource (fetch/watch: endpoints beat spec_file)", () => {
	const pinned = { ...DEFAULT_CONFIG, api_endpoint: "https://staging.example.com/openapi.json", spec_file: "openapi.json" };
	it("bare fetch on a pinned config resolves to the endpoint", () => {
		expect(resolveLiveSpecSource(pinned, "/p")).toEqual({ type: "remote", endpoint: "https://staging.example.com/openapi.json" });
	});
	it("flag endpoint > flag specFile > config endpoint > config spec_file", () => {
		expect(resolveLiveSpecSource(pinned, "/p", { endpoint: "http://localhost:3000/openapi.json", specFile: "x.json" }))
			.toEqual({ type: "remote", endpoint: "http://localhost:3000/openapi.json" });
		expect(resolveLiveSpecSource(pinned, "/p", { specFile: "x.json" })).toEqual({ type: "local", path: "/p/x.json" });
		expect(resolveLiveSpecSource({ ...pinned, api_endpoint: undefined }, "/p")).toEqual({ type: "local", path: "/p/openapi.json" });
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/config.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** in `src/core/config.ts`, directly below `resolveSpecSource`:

```ts
/**
 * Spec source for the LIVE commands (`fetch`, `watch`), which mean "pull
 * from a running backend": endpoints beat the pinned `spec_file`, inverting
 * `resolveSpecSource` (used by the offline commands, where pins win).
 * Behavior change note: configs that set BOTH api_endpoint and spec_file
 * previously read the file on bare `fetch`; in pinned mode both are set and
 * bare `fetch` must hit the endpoint (see 2026-09-20 design spec §4).
 */
export function resolveLiveSpecSource(
  config: ApiConfig,
  projectRoot: string,
  flags?: { endpoint?: string; specFile?: string },
): SpecSource {
  if (flags?.endpoint) {
    return { type: "remote", endpoint: flags.endpoint };
  }
  if (flags?.specFile) {
    const p = path.isAbsolute(flags.specFile) ? flags.specFile : path.join(projectRoot, flags.specFile);
    return { type: "local", path: p };
  }
  if (config.api_endpoint) {
    return { type: "remote", endpoint: config.api_endpoint };
  }
  return resolveSpecSource(config, projectRoot, undefined);
}
```

In `src/core/actions/fetch.ts`, replace the current resolution (`const specSource = options.endpoint ? { type: "remote" as const, endpoint: options.endpoint } : resolveSpecSource(config, projectRoot, options.specFile);`) with:

```ts
	const specSource = resolveLiveSpecSource(config, projectRoot, {
		endpoint: options.endpoint,
		specFile: options.specFile,
	});
```

(update the import from `../config.js`). In `src/core/actions/watch.ts`, find its `resolveSpecSource(` call and switch it to `resolveLiveSpecSource(config, projectRoot, { specFile: <existing flag arg if any> })`, preserving whatever flag it currently forwards.

- [ ] **Step 4: Run** `npx vitest run tests/config.test.ts && npm test && npx tsc --noEmit` → green (existing fetch tests must still pass; if any asserted the old file-first behavior for both-set configs, update them to the new rule and note it in the commit body).
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat(fetch): live commands prefer endpoints over pinned spec_file"`

---

### Task 5: `sync` action — the only writer of pinned files

**Files:**
- Create: `src/core/actions/sync.ts`
- Test: `tests/sync-action.test.ts`

**Interfaces:**
- Consumes: `loadConfig(path, { localOverlay: false })` (Task 2), `isPinnedMode` (Task 1), `fetchOpenApiSpec`, `computeHash`, `saveCacheMetadata`, `interpolateHeaders`, `resolveBasicAuthNonInteractive`, `buildBasicAuthHeader` (fetcher), `parseManifest`/`diffManifests` (manifest), `writeBusFiles` (emit), `BUS_FETCH_TIMEOUT_MS` (bus/fetch), `generate`/`generateClientFiles` (generator), `loadHooks`.
- Produces: `executeSync(options: SyncActionOptions, logger: Logger): Promise<SyncActionResult>` with `SyncActionOptions { configPath?: string }` and `SyncActionResult { specChanged: boolean; busChanged: boolean | null; busDiff: BusDiff | null; typeCount: number; operationCount: number }`. Task 6 (CLI) and Task 8 (init first-sync) call exactly this.

- [ ] **Step 1: Write failing tests** — create `tests/sync-action.test.ts`:

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeSync } from "../src/core/actions/sync.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { DEFAULT_CONFIG, generateConfigTemplate, getOutputPaths } from "../src/core/config.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

const PETSTORE_SPEC = readFileSync(new URL("./fixtures/petstore.json", import.meta.url), "utf8");

function entry(name: string, declaration: string, source = "src/types.chowbea.ts") {
	return { name, kind: "type" as const, declaration, source, line: 1, hash: hashText(declaration) };
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** Serves the spec at /openapi.json and the manifest at /bus.json; records bus request headers. */
function serveBackend(spec: string, manifestJson: string, seenBusHeaders: Record<string, string | string[] | undefined>[] = []): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.url === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(spec); return; }
			if (req.url === "/bus.json") {
				seenBusHeaders.push(req.headers);
				res.writeHead(200, { "content-type": "application/json" }); res.end(manifestJson); return;
			}
			res.writeHead(404); res.end();
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

function fixture(baseUrl: string, extra: Record<string, string> = {}) {
	const config = {
		...DEFAULT_CONFIG,
		api_endpoint: `${baseUrl}/openapi.json`,
		spec_file: "openapi.json",
		output: { folder: "api" },
		bus: { endpoint: `${baseUrl}/bus.json`, file: "chowbea.bus.json" },
	};
	const { dir, cleanup } = makeBusFixture({
		"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
		"api.config.toml": generateConfigTemplate(config),
		...extra,
	});
	return { dir, cleanup, config };
}

/** loadConfig resolves projectRoot from cwd — every executeSync runs chdir'd into the fixture. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(orig);
	}
}

function runSync(dir: string) {
	return inDir(dir, () => executeSync({ configPath: join(dir, "api.config.toml") }, SILENT_LOGGER));
}

const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
const manifestJson = `${JSON.stringify(manifest, null, "\t")}\n`;

describe("executeSync", () => {
	it("first sync writes both pinned files and regenerates", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup, config } = fixture(base);
		try {
			const result = await runSync(dir);
			expect(result.specChanged).toBe(true);
			expect(result.busChanged).toBe(true);
			expect(JSON.parse(readFileSync(join(dir, "openapi.json"), "utf8"))).toEqual(JSON.parse(PETSTORE_SPEC));
			expect(readFileSync(join(dir, "chowbea.bus.json"), "utf8")).toBe(manifestJson);
			const paths = getOutputPaths(config, dir);
			expect(readFileSync(join(paths.busDir, "core.ts"), "utf8")).toContain("Grade");
			expect(existsSync(paths.operations)).toBe(true);
		} finally { cleanup(); }
	});

	it("unchanged upstream writes nothing (byte-identical pins) and sends If-None-Match", async () => {
		const seen: Record<string, string | string[] | undefined>[] = [];
		const base = await serveBackend(PETSTORE_SPEC, manifestJson, seen);
		const { dir, cleanup } = fixture(base);
		try {
			await runSync(dir);
			const specBytes = readFileSync(join(dir, "openapi.json"));
			const busBytes = readFileSync(join(dir, "chowbea.bus.json"));
			const second = await runSync(dir);
			expect(second.specChanged).toBe(false);
			expect(second.busChanged).toBe(false);
			expect(readFileSync(join(dir, "openapi.json"))).toEqual(specBytes);
			expect(readFileSync(join(dir, "chowbea.bus.json"))).toEqual(busBytes);
			expect(seen[1]["if-none-match"]).toBe(`"${manifest.hash}"`);
		} finally { cleanup(); }
	});

	it("reports the bus diff against the previous pin", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base, {
			"chowbea.bus.json": `${JSON.stringify(buildManifest({ core: [entry("Old", "export type Old = 1;")] }), null, "\t")}\n`,
		});
		try {
			const result = await runSync(dir);
			expect(result.busDiff).toEqual({ added: ["Grade"], removed: ["Old"], changed: [] });
		} finally { cleanup(); }
	});

	it("a failing bus endpoint writes nothing at all — not even the changed spec", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base);
		writeFileSync(
			join(dir, "api.config.toml"),
			readFileSync(join(dir, "api.config.toml"), "utf8").replace("/bus.json", "/missing.json"),
			"utf8",
		);
		try {
			await expect(runSync(dir)).rejects.toThrow(/404/);
			expect(existsSync(join(dir, "openapi.json"))).toBe(false);
		} finally { cleanup(); }
	});

	it("ignores api.config.local.toml", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base, {
			"api.config.local.toml": `api_endpoint = "http://127.0.0.1:1/openapi.json"\n`,
		});
		try {
			const result = await runSync(dir);
			expect(result.specChanged).toBe(true); // used the committed endpoint, not the dead local one
		} finally { cleanup(); }
	});

	it("requires pinned-mode config", async () => {
		const { dir, cleanup } = fixture("http://127.0.0.1:1");
		writeFileSync(
			join(dir, "api.config.toml"),
			readFileSync(join(dir, "api.config.toml"), "utf8").replace(/spec_file = .*\n/, ""),
			"utf8",
		);
		try {
			await expect(runSync(dir)).rejects.toThrow(/spec_file/);
		} finally { cleanup(); }
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/sync-action.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/core/actions/sync.ts` (tabs):

```ts
/**
 * `sync` action — the ONLY writer of the pinned input files (`spec_file`,
 * `[bus].file`). Fetches from the committed stable endpoints (the local
 * overlay is deliberately ignored), validates everything BEFORE writing
 * anything, writes only artifacts whose content hash changed, then
 * regenerates types from the pins. Fails loud: a bot must never open a PR
 * from a half-updated or unvalidated state, so unlike `fetch` there is no
 * cache fallback and no swallowed bus failure.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { ensureOutputFolders, getOutputPaths, isPinnedMode, loadConfig } from "../config.js";
import {
	buildBasicAuthHeader,
	computeHash,
	fetchOpenApiSpec,
	interpolateHeaders,
	resolveBasicAuthNonInteractive,
	saveCacheMetadata,
} from "../fetcher.js";
import { BUS_FETCH_TIMEOUT_MS } from "../bus/fetch.js";
import { writeBusFiles } from "../bus/emit.js";
import { diffManifests, parseManifest, type BusDiff, type BusManifest } from "../bus/manifest.js";
import { generate, generateClientFiles } from "../generator.js";
import { loadHooks } from "../hooks-loader.js";

export interface SyncActionOptions {
	configPath?: string;
}

export interface SyncActionResult {
	specChanged: boolean;
	/** null when `[bus]` is not configured. */
	busChanged: boolean | null;
	busDiff: BusDiff | null;
	typeCount: number;
	operationCount: number;
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
	try {
		return await readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
}

export async function executeSync(
	options: SyncActionOptions,
	logger: Logger,
): Promise<SyncActionResult> {
	logger.header("chowbea-axios sync");

	// Committed truth in, committed truth out: never merge the local overlay.
	const { config, projectRoot, localOverridePresent } = await loadConfig(options.configPath, {
		localOverlay: false,
	});
	if (localOverridePresent) {
		logger.info("api.config.local.toml present — ignored by sync (pins come from the committed config)");
	}

	if (!isPinnedMode(config)) {
		throw new Error(
			"sync requires pinned-inputs mode: set both api_endpoint (stable source) and spec_file (committed pin path) in api.config.toml",
		);
	}
	if (config.bus && !config.bus.file) {
		throw new Error(
			"sync requires [bus].file when [bus] is configured — the committed manifest path (e.g. \"chowbea.bus.json\")",
		);
	}

	const outputPaths = getOutputPaths(config, projectRoot);
	await ensureOutputFolders(outputPaths);

	// Shared headers/auth, same precedence as fetch: Basic Auth (resolved
	// non-interactively — sync must never block on a TTY) wins over any
	// explicit Authorization header.
	const headers: Record<string, string> = config.fetch?.headers
		? interpolateHeaders(config.fetch.headers)
		: {};
	const auth =
		config.fetch?.auth?.type === "basic"
			? resolveBasicAuthNonInteractive(config.fetch.auth)
			: undefined;

	// --- Fetch + validate EVERYTHING before writing anything. ---

	const specResult = await fetchOpenApiSpec({
		endpoint: config.api_endpoint as string,
		specPath: outputPaths.spec,
		cachePath: outputPaths.cache,
		logger,
		force: true,
		headers: Object.keys(headers).length > 0 ? { ...headers } : undefined,
		auth,
	});
	if (specResult.fromCache) {
		throw new Error(
			"sync requires the live endpoint — refusing to pin from the cache fallback after network failure",
		);
	}
	const pinnedSpecPath = path.resolve(projectRoot, config.spec_file as string);
	const existingSpec = await readIfExists(pinnedSpecPath);
	const specChanged = existingSpec === null || computeHash(existingSpec) !== specResult.hash;

	let busChanged: boolean | null = null;
	let busDiff: BusDiff | null = null;
	let newManifest: BusManifest | null = null;
	let manifestToEmit: BusManifest | null = null;
	let pinnedBusPath: string | null = null;
	if (config.bus) {
		pinnedBusPath = path.resolve(projectRoot, config.bus.file as string);
		const existingBusText = (await readIfExists(pinnedBusPath))?.toString("utf8") ?? null;
		let previous: BusManifest | null = null;
		if (existingBusText !== null) {
			try {
				previous = parseManifest(existingBusText);
			} catch {
				previous = null; // unreadable pin: treat as first sync, rewrite it
			}
		}

		const busHeaders: Record<string, string> = { ...headers };
		if (auth) {
			for (const key of Object.keys(busHeaders)) {
				if (key.toLowerCase() === "authorization") delete busHeaders[key];
			}
			busHeaders["Authorization"] = buildBasicAuthHeader(auth);
		}
		if (previous) busHeaders["if-none-match"] = `"${previous.hash}"`;

		const response = await fetch(config.bus.endpoint, {
			headers: busHeaders,
			signal: AbortSignal.timeout(BUS_FETCH_TIMEOUT_MS),
		});
		if (response.status === 304) {
			busChanged = false;
			manifestToEmit = previous;
		} else if (!response.ok) {
			throw new Error(
				`Type bus fetch failed: ${response.status} ${response.statusText} from ${config.bus.endpoint}`,
			);
		} else {
			newManifest = parseManifest(await response.text()); // trust boundary; throws loud
			busChanged = previous === null || previous.hash !== newManifest.hash;
			manifestToEmit = newManifest;
			busDiff = previous && busChanged ? diffManifests(previous, newManifest) : null;
		}
	}

	// --- All fetched and validated: write the pins that changed. ---

	if (specChanged) {
		await writeFile(pinnedSpecPath, specResult.buffer);
		logger.info({ path: pinnedSpecPath }, "Pinned spec updated");
	}
	if (config.bus && busChanged && newManifest && pinnedBusPath) {
		await writeFile(pinnedBusPath, `${JSON.stringify(newManifest, null, "\t")}\n`, "utf8");
		logger.info({ path: pinnedBusPath }, "Pinned bus manifest updated");
	}
	if (busDiff) {
		for (const name of busDiff.added) logger.info(`bus: + ${name}`);
		for (const name of busDiff.changed) logger.info(`bus: ~ ${name}`);
		for (const name of busDiff.removed) logger.warn(`bus: - ${name} (removed)`);
	}

	// --- Regenerate from the pins so the tree is consistent after a sync. ---

	await writeFile(outputPaths.spec, specResult.buffer);
	await saveCacheMetadata(outputPaths.cache, {
		hash: specResult.hash,
		timestamp: Date.now(),
		endpoint: config.api_endpoint as string,
	});
	await generateClientFiles({ paths: outputPaths, instanceConfig: config.instance, logger });
	const hooks = await loadHooks(projectRoot, logger);
	const genResult = await generate({
		paths: outputPaths,
		logger,
		dryRun: false,
		skipTypes: false,
		skipOperations: false,
		hooks,
	});
	let typeCount = 0;
	if (manifestToEmit) {
		await writeBusFiles(manifestToEmit, outputPaths.busDir);
		typeCount = Object.values(manifestToEmit.barrels).flat().length;
	}

	logger.done(
		`sync complete — spec ${specChanged ? "changed" : "unchanged"}` +
			(busChanged === null ? "" : `, bus ${busChanged ? "changed" : "unchanged"}`),
	);

	return {
		specChanged,
		busChanged,
		busDiff,
		typeCount,
		operationCount: genResult.operationCount,
	};
}
```

- [ ] **Step 4: Run** `npx vitest run tests/sync-action.test.ts` → PASS; `npm test && npx tsc --noEmit` → green.
- [ ] **Step 5: Commit** — `git add src/core/actions/sync.ts tests/sync-action.test.ts && git commit -m "feat(sync): sync action — sole writer of pinned inputs, loud failures"`

---

### Task 6: `sync` CLI registration

**Files:**
- Modify: `src/headless/runner.ts` (`COMMANDS` list ~line 46, `printHelp` command list, `printCommandHelp` map, new `handleSync`, dispatch `switch` ~line 860)

**Interfaces:**
- Consumes: `executeSync`, `SyncActionOptions` (Task 5).
- Produces: `chowbea-axios sync [-c|--config <path>] [-q|--quiet] [-v|--verbose]`; non-zero exit on failure. Task 7's workflow and Task 8's docs invoke exactly `npx chowbea-axios sync`.

- [ ] **Step 1: Implement** (no unit test exists for the runner — parity with every other command; verification is the build smoke in Step 2). Add to imports:

```ts
import { executeSync } from "../core/actions/sync.js";
import type { SyncActionOptions } from "../core/actions/sync.js";
```

Add `"sync",` to `COMMANDS` (after `"generate",`). Add to `printHelp` commands block:

```
    sync         Update pinned API inputs (openapi.json, chowbea.bus.json) from the stable endpoint
```

Add to the `helps` record in `printCommandHelp`:

```ts
		sync: `
  ${"\x1b[1m"}chowbea-axios sync${"\x1b[0m"} - Update the pinned API inputs from the stable endpoint

  Reads ONLY the committed api.config.toml (api.config.local.toml is
  ignored), fetches the spec and type-bus manifest, writes the pinned
  files when their content changed, and regenerates types from them.

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
```

Add the handler (model: `handleGenerate`):

```ts
async function handleSync(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({ quiet: values.quiet, verbose: values.verbose });
	const logger = createLogger({ level });
	const options: SyncActionOptions = { configPath: values.config };

	try {
		await executeSync(options, logger);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}
```

Add to the dispatch switch after the `generate` case:

```ts
		case "sync":
			await handleSync(commandArgs);
			break;
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit && npm run build && node bin/chowbea-axios.js sync --help` prints the sync help; `node bin/chowbea-axios.js sync` in this repo (no api.config pinned setup) exits 1 with an actionable error. `npm test` stays green.
- [ ] **Step 3: Commit** — `git add src/headless/runner.ts && git commit -m "feat(cli): register sync command"`

---

### Task 7: CI templates — `chowbea-sync.yml` + `chowbea-pinned-ci.yml`

**Files:**
- Create: `templates/chowbea-sync.yml`, `templates/chowbea-pinned-ci.yml`
- Modify: `templates/chowbea-axios-ci.yml` (append backend dispatch snippet to the existing Type Bus comment block)
- Test: `tests/templates.test.ts` (new)

**Interfaces:**
- Produces: template filenames Task 8's `init` copies verbatim: `chowbea-sync.yml`, `chowbea-pinned-ci.yml`.

- [ ] **Step 1: Write failing test** — `tests/templates.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates", import.meta.url));

describe("workflow templates", () => {
	it("every template parses as YAML with jobs and permissions blocks", () => {
		const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".yml"));
		expect(files.sort()).toEqual(["chowbea-axios-ci.yml", "chowbea-pinned-ci.yml", "chowbea-sync.yml"]);
		for (const file of files) {
			const doc = parse(readFileSync(join(TEMPLATES_DIR, file), "utf8")) as Record<string, unknown>;
			expect(doc.jobs, file).toBeTypeOf("object");
			expect(doc.permissions, file).toBeTypeOf("object");
		}
	});
	it("sync template triggers on repository_dispatch chowbea-sync + cron + manual", () => {
		// The `yaml` package (YAML 1.2) parses a bare `on:` key as the string "on".
		const doc = parse(readFileSync(join(TEMPLATES_DIR, "chowbea-sync.yml"), "utf8")) as Record<string, any>;
		expect(doc.on.repository_dispatch.types).toEqual(["chowbea-sync"]);
		expect(doc.on.schedule[0].cron).toBeTypeOf("string");
		expect("workflow_dispatch" in doc.on).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/templates.test.ts` → FAIL (files missing).

- [ ] **Step 3: Create `templates/chowbea-sync.yml`:**

```yaml
# Keeps the pinned API inputs (openapi.json + chowbea.bus.json) in sync
# with the stable endpoint, opening a PR when the backend published a new
# contract. Pairs with pinned-inputs mode (spec_file + [bus].file set).
#
# Setup:
#   1. The BACKEND repo's deploy workflow fires the doorbell AFTER a
#      successful deploy (on push the endpoint still serves the old
#      contract):
#
#        - name: Notify client repos of new API contract
#          env:
#            GH_TOKEN: ${{ secrets.CHOWBEA_SYNC_TOKEN }}  # fine-grained PAT (contents: write on the client repos) or GitHub App token
#          run: |
#            for repo in ${{ vars.CHOWBEA_CLIENT_REPOS }}; do   # e.g. "org/web org/mobile"
#              gh api "repos/${repo}/dispatches" -f event_type=chowbea-sync
#            done
#
#   2. If your endpoints need auth, uncomment the env block below and add
#      the env vars referenced in [fetch.auth] as repository secrets.

name: Sync API Types

on:
  repository_dispatch:
    types: [chowbea-sync]
  workflow_dispatch:
  schedule:
    - cron: "17 6 * * *" # daily safety net for a missed dispatch

permissions:
  contents: write
  pull-requests: write

# Serialize runs; never cancel one mid-PR-update.
concurrency:
  group: chowbea-sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Sync pinned API inputs from the stable endpoint
        run: npx chowbea-axios sync
        # env:
        #   SWAGGER_USER: ${{ secrets.SWAGGER_USER }}
        #   SWAGGER_PASS: ${{ secrets.SWAGGER_PASS }}

      - name: Open PR when the contract changed
        uses: peter-evans/create-pull-request@v7
        with:
          branch: chowbea/sync
          commit-message: "chore(api): sync API types from stable endpoint"
          title: "chore(api): sync API types"
          body: |
            The backend published a new API contract. This PR updates the
            pinned inputs (`openapi.json`, `chowbea.bus.json`); CI
            regenerates types from them and typechecks the app before merge.

            After checking out this branch locally, run
            `npx chowbea-axios generate` to refresh `_generated/`.
```

- [ ] **Step 4: Create `templates/chowbea-pinned-ci.yml`:**

```yaml
# PR check for pinned-inputs mode: regenerate the client from the COMMITTED
# openapi.json + chowbea.bus.json — fully offline, no endpoint, no secrets —
# then typecheck. Staleness of main is the "Sync API Types" workflow's job,
# not this gate's.

name: Validate Generated API Client (pinned)

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout PR branch
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Generate types from pinned inputs (offline)
        run: npx chowbea-axios generate --quiet

      - name: Typecheck
        run: npx tsc --noEmit # replace with your project's typecheck/build command
```

- [ ] **Step 5:** In `templates/chowbea-axios-ci.yml`, extend the existing Type Bus comment block (lines 60–66) with two lines pointing at the alternative:

```yaml
# Prefer never committing generated code? See pinned-inputs mode:
# `chowbea-axios init --pinned` scaffolds chowbea-pinned-ci.yml + chowbea-sync.yml instead.
```

- [ ] **Step 6: Run** `npx vitest run tests/templates.test.ts` → PASS (adjust the `on` access if the `yaml` parser yields the literal key `"on"` — assert on whichever the test run shows). `npm test` green.
- [ ] **Step 7: Commit** — `git add templates tests/templates.test.ts && git commit -m "feat(templates): sync workflow + pinned PR-check templates"`

---

### Task 8: `init --pinned`

**Files:**
- Modify: `src/core/actions/init.ts` (`InitActionOptions` ~line 95, config creation ~line 258, `setupWorkflow` ~line 892, `ensureGitignoreEntries` ~line 959, main flow ~lines 1230–1285)
- Modify: `src/headless/runner.ts` (`handleInit` parseArgs + `printCommandHelp.init`)
- Test: `tests/init-pinned.test.ts` (new)

**Interfaces:**
- Consumes: `executeSync` (Task 5), `generateConfigTemplate` pinned emission (Task 1), template filenames (Task 7), `ensureGitignoreEntry(projectRoot, entry, comment)` from `./env-manager.js`.
- Produces: `InitActionOptions.pinned?: boolean`; in pinned mode init writes a config with `api_endpoint` + `spec_file = "openapi.json"` + a commented `[bus]` example, gitignores `_generated/` and `api.config.local.toml`, scaffolds `chowbea-pinned-ci.yml` + `chowbea-sync.yml` (instead of `chowbea-axios-ci.yml`), and runs a first `sync` that warns-and-continues on failure. `InitResult` gains `pinned: boolean` and `initialSyncSuccess: boolean | null`.

- [ ] **Step 1: Write failing test** — create `tests/init-pinned.test.ts`. A throwing prompt stub doubles as proof that `nonInteractive: true` never prompts. The dead endpoint (`127.0.0.1:1`) makes the first sync fail fast-ish (3 retries, ~3s) and exercises the warn-and-continue path.

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import toml from "toml";
import { describe, expect, it } from "vitest";

import { executeInit, type PromptProvider } from "../src/core/actions/init.js";
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
	});
});
```

(If `PromptProvider` is not exported from `init.ts`, it is — `runner.ts` imports it; keep the stub cast as written.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/init-pinned.test.ts` → FAIL (`pinned` unknown option).

- [ ] **Step 3: Implement in `src/core/actions/init.ts`:**

1. `InitActionOptions` gains:

```ts
  /** Pinned-inputs mode: commit openapi.json/chowbea.bus.json, gitignore _generated/. */
  pinned?: boolean;
```

2. `InitResult` gains `pinned: boolean;` and `initialSyncSuccess: boolean | null;` (set `initialSyncSuccess: null` everywhere `initialFetchSuccess: null` is currently set, and `pinned: options.pinned ?? false`).

3. At the config-creation call (~line 258, `generateConfigTemplate({ ... })`): when `options.pinned` and the spec source is remote, pass BOTH `api_endpoint: <endpoint>` and `spec_file: "openapi.json"` into the template config so Task 1's pinned emission fires; then append a commented bus example to the written config content:

```ts
  const pinnedBusExample = options.pinned
    ? `\n# Type Bus (optional) — uncomment and point at your API's manifest route:\n# [bus]\n# endpoint = "https://staging.example.com/.well-known/chowbea.json"\n# file = "chowbea.bus.json"\n`
    : "";
```

(`options.pinned` with a local `specSource` is a config error: throw `new Error("--pinned requires a remote endpoint (--endpoint) — the pinned spec is synced FROM it")`.)

4. `ensureGitignoreEntries(projectRoot, logger)` gains a `pinned: boolean` parameter; when true it additionally calls `ensureGitignoreEntry` for `"_generated/"` with comment `"# chowbea-axios generated output (pinned-inputs mode — regenerate with \`chowbea-axios generate\`)"` and `"api.config.local.toml"` with `"# per-dev chowbea-axios overrides (endpoints, tunnels)"`. Update its call site (~line 1236) to pass `options.pinned ?? false`.

5. `setupWorkflow` gains `pinned: boolean` and a `nonInteractive: boolean`. In non-interactive mode it must never call `prompts.confirm`: `wantsWorkflow = !options.skipWorkflow`, and an existing file is overwritten only when `force` (verify how the current code guards its confirms in non-interactive mode first and follow the same pattern if one exists). When pinned, it copies TWO templates — `chowbea-pinned-ci.yml` and `chowbea-sync.yml` — each to `.github/workflows/<same name>` using the exact existing template-resolution code (`path.resolve(thisDir, "..", "..", "..", "templates", <name>)`), with the same exists/overwrite handling per file, and logs `"Backend setup: fire repository_dispatch (event_type: chowbea-sync) after deploy — see the comment header in chowbea-sync.yml"` instead of the STAGING_API_ENDPOINT hint. When not pinned, unchanged.

6. In the main flow where `runInitialFetch` runs (~line 1246), branch:

```ts
  let initialSyncSuccess: boolean | null = null;
  if (options.pinned) {
    try {
      const { executeSync } = await import("./sync.js");
      await executeSync({ configPath }, logger);
      initialSyncSuccess = true;
    } catch (error) {
      initialSyncSuccess = false;
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "First sync failed (endpoint unreachable?) — scaffold is complete; run `chowbea-axios sync` once the endpoint is up",
      );
    }
  } else {
    // existing runInitialFetch path, untouched
  }
```

7. In `src/headless/runner.ts` `handleInit`: add `pinned: { type: "boolean", default: false }` to its parseArgs options, forward `pinned: values.pinned ?? false` into `InitActionOptions`, and add to `printCommandHelp.init`:

```
        --pinned           Pinned-inputs mode: commit openapi.json + chowbea.bus.json, gitignore _generated/
```

Interactive mode: after the existing spec-source prompt, when the source is remote and `--pinned` was not passed, ask once:

```ts
  const pinned = options.pinned ?? (options.nonInteractive ? false : await prompts.confirm({
    message: "Pin API inputs in git (team CI/CD mode: commit openapi.json, gitignore _generated/)?",
    default: false,
  }));
```

and use `pinned` everywhere `options.pinned` is read below that point.

- [ ] **Step 4: Run** `npx vitest run tests/init-pinned.test.ts` → PASS; `npm test && npx tsc --noEmit` → green.
- [ ] **Step 5: Commit** — `git add src/core/actions/init.ts src/headless/runner.ts tests/init-pinned.test.ts && git commit -m "feat(init): --pinned scaffolds pinned-inputs mode (config, gitignore, workflows, first sync)"`

---

### Task 9: `doctor` — flag tracked `_generated/` in pinned mode

**Files:**
- Modify: `src/core/config.ts` (`OutputPaths` + `getOutputPaths`: expose `generated: string`)
- Modify: `src/core/actions/doctor.ts`
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `isPinnedMode` (Task 1), existing `listTrackedFiles`/`removeFromIndex`/`ensureGitignoreEntry` plumbing in doctor.
- Produces: `OutputPaths.generated: string`; `DoctorResult` unchanged in shape — pinned-mode `_generated/**` tracked files are appended to `trackedArtifacts` and repaired by the same `--fix`.

- [ ] **Step 1: Write failing test** in `tests/doctor.test.ts` (the file already has `makeTempGitRepo`, `inDir`, `scaffoldProject`, `SILENT_LOGGER` in scope — reuse them):

```ts
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
```

Note the existing first doctor test commits `api/_generated/api.operations.ts` under a NON-pinned config and must keep passing untouched — that is the regression guard that non-pinned setups (which legitimately commit `_generated/`) are never flagged.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/doctor.test.ts` → FAIL (`_generated` not reported).

- [ ] **Step 3: Implement.** In `src/core/config.ts` `getOutputPaths`, add `generated,` to the returned object (the `const generated = path.join(folder, "_generated")` local already exists — expose it) and add to the `OutputPaths` interface:

```ts
  /** _generated folder for regenerable output */
  generated: string;
```

In `src/core/actions/doctor.ts`: add constants

```ts
const GENERATED_IGNORE_ENTRY = "_generated/";
const GENERATED_IGNORE_COMMENT =
	"# chowbea-axios generated output (pinned-inputs mode — regenerate with `chowbea-axios generate`)";
```

After the `_internal` scan, when `isPinnedMode(config)`:

```ts
	if (isPinnedMode(config)) {
		const generatedRel = path.relative(projectRoot, paths.generated).split(path.sep).join("/");
		trackedArtifacts.push(...listTrackedFiles(projectRoot, generatedRel));
	}
```

(make `trackedArtifacts` a mutable array) and in the `--fix` branch, alongside the `_internal` ignore-rule repair, add the `_generated/` rule via `ensureGitignoreEntry(projectRoot, GENERATED_IGNORE_ENTRY, GENERATED_IGNORE_COMMENT)` — only when `isPinnedMode(config)`. The untrack/stage path already operates on `trackedArtifacts`, so no further change.

- [ ] **Step 4: Run** `npx vitest run tests/doctor.test.ts && npm test && npx tsc --noEmit` → green.
- [ ] **Step 5: Commit** — `git add src/core/config.ts src/core/actions/doctor.ts tests/doctor.test.ts && git commit -m "feat(doctor): flag tracked _generated output in pinned mode"`

---

### Task 10: README — Team CI/CD (pinned inputs) + migration guide

**Files:**
- Modify: `README.md` (new section after "CI Integration"; update the "Consume (frontend repo)" Type Bus snippet to mention `file`)

**Interfaces:** none (docs).

- [ ] **Step 1: Write the section** after "## CI Integration":

```markdown
## Team CI/CD — Pinned Inputs (recommended for teams)

Commit the *inputs* (`openapi.json` + `chowbea.bus.json`), gitignore all
generated output. The pins are a lockfile for your API contract: builds are
offline and reproducible, and backend changes reach the frontend as
reviewable PRs — never from a dev's local backend.

```toml
api_endpoint = "https://staging.example.com/openapi.json"  # stable endpoint (sync source)
spec_file    = "openapi.json"                              # pinned spec, committed

[bus]
endpoint = "https://staging.example.com/.well-known/chowbea.json"
file     = "chowbea.bus.json"                              # pinned manifest, committed
```

- `generate` — offline: pinned files → `_generated/` (gitignored). What CI runs on every PR.
- `fetch [--endpoint URL]` — dev loop: any live backend → gitignored caches + `_generated/`. Never touches the pins.
- `sync` — the only pin writer: stable endpoint → validate → write pins on change → regenerate. Run by CI.

**Per-dev endpoints** (ports, tunnels): create a gitignored
`api.config.local.toml` next to the committed config — field-level override,
local wins. `sync` deliberately ignores it.

```toml
# api.config.local.toml
api_endpoint = "https://my-tunnel.ngrok.app/openapi.json"
[bus]
endpoint = "https://my-tunnel.ngrok.app/.well-known/chowbea.json"
```

**Backend → frontend doorbell:** the backend's deploy workflow fires
`repository_dispatch` (event `chowbea-sync`) at each client repo *after a
successful deploy*; the scaffolded `chowbea-sync.yml` workflow runs `sync`
and opens a PR only when the contract changed (dispatch + daily cron +
manual). See the comment header in `.github/workflows/chowbea-sync.yml`.

**New project:** `chowbea-axios init --pinned --non-interactive --endpoint https://staging.example.com/openapi.json --output-folder src/api --package-manager npm`

**Migrating an existing project:**
1. Add `spec_file = "openapi.json"` (keep `api_endpoint`) and `file = "chowbea.bus.json"` under `[bus]`.
2. `npx chowbea-axios sync` — creates the pins.
3. `git rm -r --cached src/api/_generated` and add `_generated/` + `api.config.local.toml` to `.gitignore` (`chowbea-axios doctor --fix` does both).
4. Copy `chowbea-sync.yml` + `chowbea-pinned-ci.yml` from this package's `templates/` into `.github/workflows/`, replacing the old staleness check.
5. Optional hardening: a CODEOWNERS entry for the two pinned files.
```

- [ ] **Step 2:** In the existing "Consume (frontend repo)" Type Bus snippet, extend the `[bus]` example with the optional `file` line and one sentence pointing at the new section.
- [ ] **Step 3: Verify** — `npm test` (templates test still green), render-check the README fences locally (balanced backticks).
- [ ] **Step 4: Commit** — `git add README.md && git commit -m "docs: pinned-inputs team CI/CD section + migration guide"`

---

## Final gate (after Task 10)

- [ ] `npm test && npm run test:types && npm run test:types:strict && npx tsc --noEmit && npm run build` — all green.
- [ ] Smoke: in a scratch temp dir outside the repo, `node <repo>/bin/chowbea-axios.js init --pinned --non-interactive --endpoint https://petstore3.swagger.io/api/v3/openapi.json --output-folder src/api --package-manager npm --skip-scripts` (flag names per `handleInit`), then `node <repo>/bin/chowbea-axios.js sync`, then `node <repo>/bin/chowbea-axios.js generate` — verify pins exist, `_generated/` is ignored by the scratch repo's `.gitignore`, second `sync` reports unchanged.
