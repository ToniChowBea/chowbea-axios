/**
 * Local-first execution resolution.
 *
 * When the globally-installed CLI (`chowbea`, formerly `chowbea-axios`) is run
 * inside a project that has its own copy as a dependency, the CLI hands off to
 * that project-local copy so the pinned version is what actually runs
 * (mirroring how the router already re-execs itself under Bun). These helpers
 * decide whether to delegate and report which install is running, kept pure
 * so they can be unit-tested with injected paths.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalInstall {
	/** Canonical root of the project-local CLI (`chowbea` or `chowbea-axios`) package. */
	root: string;
	/** Absolute path to its `bin` entry. */
	binPath: string;
}

export type ExecutionSource = "project" | "global";

export type DelegationDecision =
	| { action: "run" }
	| { action: "delegate"; binPath: string };

/**
 * Decide whether the running process should hand off to a project-local
 * install. Pure: the caller resolves `runningRoot` and `localInstall` (both
 * canonicalised) and passes argv/env.
 */
export function decideDelegation(params: {
	runningRoot: string;
	localInstall: LocalInstall | null;
	argv: string[];
	env: NodeJS.ProcessEnv;
}): DelegationDecision {
	const { runningRoot, localInstall, argv, env } = params;

	// Loop guard: a delegated child must never delegate again.
	if (env.CHOWBEA_LOCAL_DELEGATED === "1") return { action: "run" };
	// User opt-outs.
	if (env.CHOWBEA_NO_DELEGATE === "1") return { action: "run" };
	if (argv.includes("--global")) return { action: "run" };

	if (!localInstall) return { action: "run" }; // no project-local copy
	if (localInstall.root === runningRoot) return { action: "run" }; // already it

	return { action: "delegate", binPath: localInstall.binPath };
}

/**
 * Whether the currently-running install is the project-local one or a global
 * one. Pure string comparison of canonicalised roots.
 */
export function executionSource(params: {
	runningRoot: string;
	localRoot: string | null;
}): ExecutionSource {
	const { runningRoot, localRoot } = params;
	if (!localRoot) return "global";
	return localRoot === runningRoot ? "project" : "global";
}

/** Canonicalise a path (resolve symlinks); fall back to the input on failure. */
function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Find the package root of the running CLI by walking up from a module's
 * `import.meta.url` to the nearest `package.json`. Depth-independent, so it
 * works from `dist/router.js`, `dist/tui/screens/home.js`, or source.
 */
export function findRunningPackageRoot(importMetaUrl: string): string {
	let dir = dirname(fileURLToPath(importMetaUrl));
	while (true) {
		if (existsSync(join(dir, "package.json"))) return canonical(dir);
		const parent = dirname(dir);
		if (parent === dir) return canonical(dir); // filesystem root — give up
		dir = parent;
	}
}

/** Package directory names this CLI answers to, in resolution order. */
const PACKAGE_NAMES = ["chowbea", "chowbea-axios"] as const;
/** Bin keys to accept inside a resolved package, in preference order. */
const BIN_KEYS = ["chowbea", "chowbea-axios"] as const;

/** Read and validate a candidate `package.json`, or `null` if it has no usable bin. */
function readInstall(pkgJsonPath: string): LocalInstall | null {
	try {
		const root = canonical(dirname(pkgJsonPath));
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const bin = pkg.bin;
		const binRel =
			typeof bin === "string"
				? bin
				: BIN_KEYS.map((k) => bin?.[k]).find(Boolean);
		if (!binRel) return null;
		return { root, binPath: join(root, binRel) };
	} catch {
		return null;
	}
}

/**
 * Resolve the project-local CLI (`chowbea`, formerly `chowbea-axios`) install
 * for a working directory by walking up the `node_modules` chain — returning
 * its canonical root and `bin` entry, or `null` if the project has no local
 * copy.
 *
 * At each `node_modules` directory, `chowbea` is tried before `chowbea-axios`:
 * the transitional shim package depends on the real package, so a project
 * with the shim installed has both directories, and preferring `chowbea`
 * delegates straight to the real CLI instead of hopping through the shim. A
 * package directory found but lacking a usable bin doesn't abort the walk —
 * the sibling name is tried before moving up to the parent directory.
 *
 * A manual walk (rather than `require.resolve`) is deliberate: the running
 * CLI may itself be named `chowbea` or `chowbea-axios`, so
 * `require.resolve("chowbea/...")` could self-reference the running package
 * (and hit its `exports` map) instead of finding the project-local
 * dependency.
 */
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
		if (parent === dir) return null; // filesystem root — no local copy
		dir = parent;
	}
}
