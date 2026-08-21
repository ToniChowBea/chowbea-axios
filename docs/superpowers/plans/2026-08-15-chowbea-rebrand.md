# Chowbea Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the package from `chowbea-axios` to `chowbea` — new primary bin `chowbea`, both bin names kept, dual-name local-first delegation, and a `chowbea-axios` compatibility shim so existing consumers never break.

**Architecture:** Five independent tasks: (1) dual-name resolution in `src/core/local-resolution.ts`, (2) package identity in `package.json`, (3) the shim package under `shim/`, (4) mechanical docs/template/help-text rename, (5) workflow repo-guards. Only task 1 is real logic; the rest are bounded edits with verification.

**Tech Stack:** Node/TypeScript, vitest, npm pack smoke tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-15-chowbea-rebrand-design.md` — read before starting any task.

## Global Constraints

- ESM only: relative imports end in `.js`, including tests. Tabs in `src/`.
- No new dependencies.
- **Both bin names ship forever:** `chowbea` (primary) and `chowbea-axios` (alias). Never remove the alias.
- **Never rename:** `api.config.toml`, `_generated/`/`_internal/` layout, `*.chowbea.ts`, `chowbea.bus.json`, `/.well-known/chowbea.json`, `CHOWBEA_*` env vars, `DEFAULT_API_ROUTE`. These are brand-neutral by design.
- Run `npm test` AND `npm run build` AND `npm run test:types` before every commit.
- Conventional commits. The package-identity commit (Task 2) uses `feat!:` so release-please cuts 3.0.0; all other tasks use non-breaking types.
- The repo rename to `ToniChowBea/chowbea` is a MANUAL owner step performed after merge — Task 5 pre-stages the guards for the new slug.

---

### Task 1: Dual-name local-install resolution

**Files:**
- Modify: `src/core/local-resolution.ts` (`resolveLocalInstall`, ~line 101; doc comments at lines 4, 17, 92-99)
- Test: `tests/local-resolution.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveLocalInstall(cwd)` signature and `LocalInstall` shape unchanged — behavior only. `decideDelegation`, `executionSource`, `findRunningPackageRoot` are untouched (they compare canonical roots and are already name-agnostic).

Resolution rules (in order, per `node_modules` directory walked):
1. Try `node_modules/chowbea/package.json`; if present and it yields a bin, return it.
2. Else try `node_modules/chowbea-axios/package.json`; if present and it yields a bin, return it.
3. Else continue walking up. (Current code returns `null` on a found-but-binless package — the new code must fall through to the other name, then keep walking, instead of aborting.)

Bin key preference within a package: `bin` as a string → use it; else `bin["chowbea"]` → else `bin["chowbea-axios"]`.

Checking `chowbea` first matters: the shim depends on the real package, so a project with the shim has BOTH directories; preferring `chowbea` delegates straight to the real CLI and skips the shim hop.

- [ ] **Step 1: Write the failing tests**

Append to `tests/local-resolution.test.ts`, following the file's existing temp-dir fixture style (read it first and reuse its helper for creating `node_modules/<name>/package.json` + bin file):

```ts
describe("resolveLocalInstall: dual-name (rebrand)", () => {
	it("finds a project-local `chowbea` install", () => {
		// fixture: <dir>/node_modules/chowbea/package.json with bin { chowbea: "bin/cli.js" }
		// expect: root endsWith node_modules/chowbea, binPath endsWith bin/cli.js
	});

	it("still finds a legacy `chowbea-axios` install", () => {
		// fixture: node_modules/chowbea-axios with bin { "chowbea-axios": "bin/cli.js" }
		// expect: resolved (back-compat with pre-rename projects)
	});

	it("prefers `chowbea` when both are present (shim installs both)", () => {
		// fixture: both node_modules/chowbea and node_modules/chowbea-axios
		// expect: resolved root is the `chowbea` one
	});

	it("accepts a `chowbea` bin key inside a legacy-named package and vice versa", () => {
		// fixture: node_modules/chowbea-axios whose bin map has only { chowbea: "bin/cli.js" }
		// expect: resolved (bin key preference is independent of directory name)
	});

	it("falls through to the sibling name when the first package has no bin", () => {
		// fixture: node_modules/chowbea with NO bin field + node_modules/chowbea-axios with a bin
		// expect: resolved to the chowbea-axios one (not null)
	});

	it("keeps walking up when neither name is present in a directory", () => {
		// fixture: nested dir with node_modules/ (empty) and a parent holding node_modules/chowbea
		// expect: resolves to the parent's install
	});

	it("returns null when no install exists anywhere up the tree", () => {});
});
```

Write real bodies by copying the arrangement of the existing `resolveLocalInstall` tests in that file — the assertions above are exact.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run local-resolution`
Expected: the new describe block FAILS (chowbea-named fixtures unresolved).

- [ ] **Step 3: Implement**

Replace the body of `resolveLocalInstall` with a dual-name walk:

```ts
/** Package directory names this CLI answers to, in resolution order. */
const PACKAGE_NAMES = ["chowbea", "chowbea-axios"] as const;
/** Bin keys to accept inside a resolved package, in preference order. */
const BIN_KEYS = ["chowbea", "chowbea-axios"] as const;

function readInstall(pkgJsonPath: string): LocalInstall | null {
	try {
		const root = canonical(dirname(pkgJsonPath));
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const binRel =
			typeof pkg.bin === "string"
				? pkg.bin
				: BIN_KEYS.map((k) => pkg.bin?.[k]).find(Boolean);
		if (!binRel) return null;
		return { root, binPath: join(root, binRel) };
	} catch {
		return null;
	}
}

export function resolveLocalInstall(cwd: string): LocalInstall | null {
	let dir = canonical(cwd);
	while (true) {
		for (const name of PACKAGE_NAMES) {
			const pkgJsonPath = join(dir, "node_modules", name, "package.json");
			if (existsSync(pkgJsonPath)) {
				const install = readInstall(pkgJsonPath);
				if (install) return install;
				// found but unusable — try the sibling name, then keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
```

Update the doc comments at lines 4, 17, and 92-99 to say "the CLI (`chowbea`, formerly `chowbea-axios`)" and explain the dual-name walk + why `chowbea` is preferred (shim installs both).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run local-resolution`, then `npm test`, `npm run build`, `npm run test:types`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/local-resolution.ts tests/local-resolution.test.ts
git commit -m "feat(cli): Resolve project-local installs under both chowbea and chowbea-axios"
```

---

### Task 2: Package identity — name, bins, URLs

**Files:**
- Modify: `package.json` (`name`, `bin`, `repository`, `bugs`, `homepage` if present, `description`)
- Test: `tests/pm.test.ts` or a new assertion — see Step 1

**Interfaces:**
- Produces: package installs as `chowbea`; exposes bins `chowbea` AND `chowbea-axios`, both pointing at `bin/chowbea-axios.js` (file NOT renamed — filename is internal, and renaming it churns the shim's forwarder for no gain).

- [ ] **Step 1: Write the failing test**

Create `tests/package-identity.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	name: string;
	bin: Record<string, string>;
	repository: { url: string };
	bugs: { url: string };
	exports: Record<string, unknown>;
};

describe("package identity (rebrand)", () => {
	it("publishes as chowbea", () => {
		expect(pkg.name).toBe("chowbea");
	});

	it("ships both bin names, pointing at the same entry", () => {
		expect(pkg.bin.chowbea).toBeDefined();
		expect(pkg.bin["chowbea-axios"]).toBeDefined();
		expect(pkg.bin.chowbea).toBe(pkg.bin["chowbea-axios"]);
	});

	it("points repository and bugs at the renamed repo", () => {
		expect(pkg.repository.url).toContain("ToniChowBea/chowbea");
		expect(pkg.repository.url).not.toContain("chowbea-axios");
		expect(pkg.bugs.url).toContain("ToniChowBea/chowbea");
	});

	it("keeps the three public entry points unchanged", () => {
		expect(Object.keys(pkg.exports).sort()).toEqual([".", "./api", "./vite"]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run package-identity`
Expected: FAIL on name/bin/urls.

- [ ] **Step 3: Implement**

In `package.json`:
- `"name": "chowbea"`
- `"bin": { "chowbea": "bin/chowbea-axios.js", "chowbea-axios": "bin/chowbea-axios.js" }`
- `repository.url` → `git+ssh://git@github.com/ToniChowBea/chowbea.git`
- `bugs.url` → `https://github.com/ToniChowBea/chowbea/issues`
- `description`: drop "axios"-centric framing — e.g. `"Type-safe API client generator and TypeScript type bus, with an interactive TUI"` (keep it one line).

Do NOT touch `version` (release-please owns it), `exports`, `files`, or dependencies.

- [ ] **Step 4: Verify**

Run: `npx vitest run package-identity`, then `npm test`, `npm run build`, `npm run test:types`.
`npm pack --dry-run` lists archive *files*, not bin aliases — to confirm both commands exist, inspect the packed manifest or the installed package:

```bash
node -p "Object.keys(require('./package.json').bin)"   # -> [ 'chowbea', 'chowbea-axios' ]
```

Task 3's install smoke is what actually proves both commands run.

- [ ] **Step 5: Commit (BREAKING — this drives 3.0.0)**

```bash
git add package.json tests/package-identity.test.ts
git commit -m "feat(pkg)!: Rename package to chowbea

The package is no longer axios-specific: it generates typed API clients,
syncs arbitrary TypeScript types via the Type Bus, and ships a TUI. It now
publishes as \`chowbea\` with \`chowbea\` as the primary command.

BREAKING CHANGE: the package is published as \`chowbea\`. Install with
\`npm install chowbea\`. The \`chowbea-axios\` name continues to work via a
compatibility shim package, and the \`chowbea-axios\` command is still
provided by this package, so existing scripts keep working."
```

---

### Task 3: The `chowbea-axios` compatibility shim

**Files:**
- Create: `shim/package.json`, `shim/index.js`, `shim/vite.js`, `shim/api.js`, `shim/api.cjs`, `shim/bin.js`, `shim/README.md`
- Test: `tests/shim.test.ts`

**Interfaces:**
- Produces: a separately-publishable package named `chowbea-axios` that re-exports `chowbea`'s three entry points and forwards its bin. Published manually (not by this repo's release-please, which owns only the root package).

- [ ] **Step 1: Write the failing test**

Create `tests/shim.test.ts` — a structural test (a full install smoke is the manual Step 5, too slow for CI):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
	readFileSync(new URL(`../shim/${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as {
	name: string;
	dependencies: Record<string, string>;
	bin: Record<string, string>;
	exports: Record<string, { import?: string; require?: string; types?: string }>;
	peerDependencies?: Record<string, string>;
	engines?: Record<string, string>;
};
const root = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { peerDependencies?: Record<string, string>; engines?: Record<string, string> };

describe("chowbea-axios shim", () => {
	it("is named chowbea-axios and depends on chowbea", () => {
		expect(pkg.name).toBe("chowbea-axios");
		expect(pkg.dependencies.chowbea).toMatch(/^\^3/);
	});

	it("mirrors the three entry points, with CJS support on ./api", () => {
		expect(Object.keys(pkg.exports).sort()).toEqual([".", "./api", "./vite"]);
		expect(pkg.exports["./api"].require).toBeDefined();
	});

	it("re-exports rather than reimplements", () => {
		expect(read("index.js")).toContain('from "chowbea"');
		expect(read("vite.js")).toContain('from "chowbea/vite"');
		expect(read("api.js")).toContain('from "chowbea/api"');
		expect(read("api.cjs")).toContain('require("chowbea/api")');
	});

	it("forwards the chowbea-axios bin", () => {
		expect(pkg.bin["chowbea-axios"]).toBe("bin.js");
		expect(read("bin.js")).toContain("chowbea");
	});

	it("mirrors engines and peerDependencies so installs resolve identically", () => {
		expect(pkg.engines).toEqual(root.engines);
		expect(pkg.peerDependencies ?? {}).toEqual(root.peerDependencies ?? {});
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shim`
Expected: FAIL — `shim/` does not exist.

- [ ] **Step 3: Implement the shim**

`shim/package.json` (copy `engines`/`peerDependencies` verbatim from the root package.json at implementation time):

```json
{
	"name": "chowbea-axios",
	"version": "3.0.0",
	"description": "Deprecated alias for `chowbea` — install `chowbea` instead.",
	"type": "module",
	"license": "MIT",
	"bin": { "chowbea-axios": "bin.js" },
	"exports": {
		".": { "types": "./index.d.ts", "import": "./index.js" },
		"./vite": { "types": "./vite.d.ts", "import": "./vite.js" },
		"./api": {
			"types": "./api.d.ts",
			"import": "./api.js",
			"require": "./api.cjs"
		}
	},
	"files": ["index.js", "index.d.ts", "vite.js", "vite.d.ts", "api.js", "api.d.ts", "api.cjs", "bin.js", "README.md"],
	"dependencies": { "chowbea": "^3.0.0" },
	"repository": { "type": "git", "url": "git+ssh://git@github.com/ToniChowBea/chowbea.git", "directory": "shim" },
	"bugs": { "url": "https://github.com/ToniChowBea/chowbea/issues" }
}
```

Re-export stubs:

```js
// shim/index.js
export * from "chowbea";
```
```js
// shim/vite.js
export * from "chowbea/vite";
```
```js
// shim/api.js
export * from "chowbea/api";
```
```js
// shim/api.cjs
module.exports = require("chowbea/api");
```

Type stubs (`index.d.ts`, `vite.d.ts`, `api.d.ts`) each one line, e.g. `export * from "chowbea/api";` — add them to `files` (already listed above).

`shim/bin.js` — resolve the real CLI's bin through the dependency and exec it, preserving argv/exit code/signal:

```js
#!/usr/bin/env node
// Forwards to the `chowbea` CLI. `bin` entries are not in the exports map, so
// resolve the dependency's package.json and read its bin path from there.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("chowbea/package.json");
const pkg = require("chowbea/package.json");
const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.chowbea;
const binPath = join(dirname(pkgJsonPath), binRel);

const result = spawnSync(process.execPath, [binPath, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});
if (result.error) {
	console.error(`chowbea-axios: could not run chowbea (${result.error.message})`);
	process.exit(1);
}
if (typeof result.status === "number") process.exit(result.status);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(1);
```

**REQUIRED companion change (verified, not optional):** the root package's `exports` map does NOT list `./package.json`, and Node blocks any subpath absent from an `exports` map — so `require.resolve("chowbea/package.json")` in the shim bin will throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. Add to the ROOT `package.json` exports:

```json
"./package.json": "./package.json"
```

Add an assertion for it in `tests/package-identity.test.ts` (`expect(pkg.exports["./package.json"]).toBe("./package.json")`) so it can't be dropped later, and note that Task 2's "three entry points" assertion must then expect four keys (`.`, `./api`, `./package.json`, `./vite`) — update that test accordingly.

`shim/README.md`: short — "`chowbea-axios` has been renamed to `chowbea`. This package re-exports it so existing installs keep working. `npm install chowbea` and update imports at your convenience."

Add `shim/` to the root `.npmignore`-equivalent concern: the root `files` array lists explicit entries (`bin`, `dist`, `templates`, ...) and does NOT include `shim`, so the shim is already excluded from the main tarball. Verify this in Step 4 rather than assuming.

- [ ] **Step 4: Verify structurally**

Run: `npx vitest run shim`, then `npm test`, `npm run build`, `npm run test:types`.
Run `npm pack --dry-run` on the ROOT package and confirm no `shim/` files are included.

- [ ] **Step 5: Manual dual-package install smoke (record output in the report)**

**Version constraint:** the shim depends on `chowbea@^3.0.0`, but the root package is still on 2.x until release-please cuts the release. Installing both tarballs side by side therefore does NOT validate the packed root — npm ignores the local tarball and tries the registry (404 pre-publish). Either run this smoke *after* `chowbea@3.0.0` is published, or pin the local tarball with an `overrides` entry as below.

```bash
# from repo root
npm pack                       # -> chowbea-<ver>.tgz
cd shim && npm pack && cd ..   # -> shim/chowbea-axios-3.0.0.tgz
TMP=$(mktemp -d) && cd "$TMP" && npm init -y >/dev/null
# Pin `chowbea` to the packed tarball so the shim resolves to it rather than the registry:
npm pkg set overrides.chowbea="file:<abs>/chowbea-<ver>.tgz"
npm i <abs>/shim/chowbea-axios-3.0.0.tgz typescript
node -e "const m=require('chowbea-axios/api'); console.log(typeof m.busHandler, m.DEFAULT_API_ROUTE)"
node --input-type=module -e "import('chowbea-axios').then(m=>console.log(Object.keys(m).length>0))"
npx chowbea-axios --version && npx chowbea --version
```
Expected: CJS require prints `function /.well-known/chowbea.json`; ESM import resolves; both bins print the same version. Clean up the temp dir and tarballs.

- [ ] **Step 6: Commit**

```bash
git add shim tests/shim.test.ts
git commit -m "feat(shim): Add chowbea-axios compatibility package re-exporting chowbea"
```

---

### Task 4: Docs, templates, and user-facing strings

**Files:**
- Modify: `README.md`, `templates/chowbea-axios-ci.yml`, and every `src/` file with a user-facing `chowbea-axios` command string (find them in Step 1)
- Test: `tests/package-identity.test.ts` (extend)

**Interfaces:** none — user-visible text only.

- [ ] **Step 1: Inventory**

Run and read the output before editing:
```bash
grep -rn "chowbea-axios" src templates README.md --include="*.ts" --include="*.yml" --include="*.md" | grep -vE "\.chowbea\.ts|chowbea\.bus\.json|well-known"
```
Classify each hit: (a) a **command example** users type → change to `chowbea`; (b) a **package specifier** in an import example → change to `chowbea`; (c) an **internal filename/path** (e.g. `bin/chowbea-axios.js`, the CI template's filename) → LEAVE; (d) an intentional back-compat mention → leave and keep accurate.

- [ ] **Step 2: Write the failing assertion**

Append to `tests/package-identity.test.ts`:

```ts
describe("user-facing docs use the new name", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

	it("installs and invokes chowbea", () => {
		expect(readme).toMatch(/npm install chowbea\b/);
		expect(readme).toMatch(/npx chowbea init/);
	});

	it("keeps a migration note for the old name", () => {
		expect(readme.toLowerCase()).toContain("renamed from");
		expect(readme).toContain("chowbea-axios");
	});

	it("imports the Type Bus api surface from chowbea/api", () => {
		expect(readme).toContain('from "chowbea/api"');
		expect(readme).not.toContain('from "chowbea-axios/api"');
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run package-identity` → FAIL.

- [ ] **Step 4: Implement**

- README: `<h1>` → `Chowbea`; tagline drops the axios framing; install/quick-start commands → `chowbea`; npm badges → `chowbea`; repo badges/links → `ToniChowBea/chowbea`; Type Bus import → `chowbea/api`; commands table intro says `chowbea <command> --help`.
- Add directly under the badges, above `## Quick Start`:
  > **Renamed from `chowbea-axios`.** Install `chowbea` (`npm install chowbea`). The old package name still works via a compatibility shim, and the `chowbea-axios` command is still provided, so existing setups keep running.
- `templates/chowbea-axios-ci.yml`: `npx chowbea-axios` → `npx chowbea` in run steps and comments. Keep the FILENAME as-is (it is scaffolded into consumer repos; renaming it strands existing users' workflow files).
- `src/`: update help text, TUI strings, and error messages that print a command the user types. Do NOT touch `bin/chowbea-axios.js`'s path, `CHOWBEA_*` env var names, or `.chowbea.ts`/`chowbea.bus.json`/`/.well-known/chowbea.json` literals.

- [ ] **Step 5: Verify**

Run: `npx vitest run package-identity`, `npm test`, `npm run build`, `npm run test:types`.
Re-run the Step 1 grep and confirm every remaining hit is category (c) or (d).

- [ ] **Step 6: Commit**

```bash
git add README.md templates src tests/package-identity.test.ts
git commit -m "docs: Update commands, badges, and examples to the chowbea name"
```

---

### Task 5: Workflow repo-guards for the renamed repo

**Files:**
- Modify: `.github/workflows/release-please.yml` (guard ~line 63), `.github/workflows/release.yml` (guard ~line 98, plus the Trusted Publisher setup comment block)

**Interfaces:** none.

Context the executor needs: these guards previously caused a silent release outage — after an owner rename the guard stopped matching, every release job showed `skipped`, and nothing published. Pre-staging them for the new slug means the FIRST push after the manual repo rename works; the cost is that any release merged BETWEEN this commit and the repo rename would skip. Sequencing (spec §Sequencing) puts the repo rename immediately after this merge to keep that window closed.

- [ ] **Step 1: Implement**

In both files, change:
```yaml
if: github.repository == 'ToniChowBea/chowbea-axios'
```
to:
```yaml
if: github.repository == 'ToniChowBea/chowbea'
```

In `release.yml`'s setup comment block, update the Trusted Publisher instructions: package name is now `chowbea` (`https://www.npmjs.com/package/chowbea/access`), Organization or user `ToniChowBea`, Repository `chowbea`. Add a note that the entry can only be created once the package exists on npm, so the first `chowbea` publish is either a pre-created placeholder or a manual publish from the release tag.

- [ ] **Step 2: Verify**

Run: `npm test` (workflows aren't executed by tests, but keep the suite green), and:
```bash
grep -rn "github.repository ==" .github/workflows/
grep -rn "chowbea-axios" .github/workflows/ | grep -v "renamed\|formerly"
```
Expected: both guards show the new slug; no stale package references remain except intentional historical notes.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "ci: Point release guards and publisher docs at the renamed repo"
```

---

## Post-merge manual runbook (owner — not executable by an agent)

Perform in this order; steps 1-2 are the happy path that avoids a manual publish.

1. **Pre-create the npm package** (recommended): from a logged-in machine, publish a placeholder so a Trusted Publisher entry can be attached — `npm publish` a minimal `chowbea@0.0.0` (or publish 3.0.0 directly if the release PR is already merged and tagged).
2. **Add Trusted Publisher entries on npmjs.com** for `chowbea`: GitHub Actions, Organization `ToniChowBea`, Repository `chowbea`, Workflow `release-please.yml` (and optionally `release.yml`).
3. **Merge protocol (read before merging — this determines whether release-please cuts 3.0.0 or 2.8.0):** this repo squash-merges PRs by default. release-please derives the bump from the commit(s) that land on `main`, not from the PR's source commits, so the `feat(pkg)!:` commit on this branch is not enough by itself. Merge this PR using ONE of:
   - A **merge commit** or **rebase merge** that preserves the `feat(pkg)!:` commit (and its `BREAKING CHANGE:` footer) unchanged in `main`'s history; or
   - If **squash-merging** (the repo default), the squash commit's **title itself must be** `feat!: rename package to chowbea`, AND the squash commit's **body must retain the `BREAKING CHANGE:` footer verbatim** (GitHub's squash editor defaults to concatenating every commit's subject line into the body — trim it down to keep the footer, don't let it get pruned or buried).
   If neither condition holds, release-please sees no `!`/`BREAKING CHANGE:` on `main` and cuts a minor bump (`2.8.0`) instead of `3.0.0` — the shim's pinned `"chowbea": "^3.0.0"` dependency (spec §Package 2) then can never resolve, so the shim is dead on arrival.
4. **Merge this branch** per the protocol above.
5. **Rename the GitHub repo** to `ToniChowBea/chowbea` (Settings → General → Repository name). Guards already expect the new slug.
6. **Trigger release-please manually:** the rename in the previous step produces no push event, so the guarded `push: branches: [main]` trigger never fires and the release PR will not appear on its own — run `gh workflow run release-please.yml` (or re-run the skipped run from the merge in step 4) to generate it.
7. **Verify the release PR before doing anything else:** confirm the PR release-please opens is titled `chore(main): release 3.0.0`. **STOP here — do not proceed to publish —** if it is titled `chore(main): release 2.8.0` (or anything other than `3.0.0`); that means step 3's merge protocol wasn't followed. Fix it by amending the commit on `main` (or reverting and re-merging correctly) so the `feat!:`/`BREAKING CHANGE:` signal is present, then re-trigger release-please, before continuing to step 8.
8. **Merge the `chore(main): release 3.0.0` PR** — it tags, builds, tests, and publishes `chowbea@3.0.0` via OIDC.
9. **Publish the shim:** `cd shim && npm publish` (manual; this repo's release automation owns only the root package).
10. **Deprecate the old name:** `npm deprecate chowbea-axios "Renamed to chowbea — npm install chowbea"`.
11. **Update local remotes** (optional; GitHub redirects work): `git remote set-url origin git@github.com:ToniChowBea/chowbea.git`.
12. **Consumers:** `npm i chowbea` at leisure; imports may switch from `chowbea-axios/*` to `chowbea/*` whenever convenient, or never.

## Self-Review (completed)

- **Spec coverage:** strategy §Package 1 → Task 2; §Package 2 (shim) → Task 3; §dual-name delegation → Task 1; §release plumbing/guards → Task 5 + runbook; §find-replace tier → Task 4; §deliberately unchanged → Global Constraints (enforced negatively, plus Task 4 Step 1 classification); §testing → embedded per task; §sequencing → runbook.
- **Type consistency:** `LocalInstall`/`resolveLocalInstall` signatures unchanged across Task 1; shim export names mirror the root package's three entry points verified in Task 3's test.
- **Known judgment calls flagged for the executor:** whether the root `exports` map blocks `chowbea/package.json` resolution (Task 3, Step 3 — verify and add the export if needed); which `src/` strings are commands vs internal paths (Task 4, Step 1 — classify before editing).
