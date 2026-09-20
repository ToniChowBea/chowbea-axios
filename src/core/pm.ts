/**
 * Package manager detection and command helpers.
 * Shared across init, generate, and fetch commands.
 */

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Supported package managers.
 */
export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/**
 * Detects the package manager based on lockfile presence.
 * Checks in order: pnpm, yarn, bun, npm. Defaults to npm if none found.
 *
 * Both `bun.lock` (text format, the modern Bun default since v1.1.27)
 * and `bun.lockb` (binary format, legacy) are detected — the previous
 * implementation only checked the binary form and misdetected modern
 * Bun-managed projects as npm. Issue #24.
 */
export async function detectPackageManager(
	projectRoot: string
): Promise<PackageManager> {
	const lockfiles: [string, PackageManager][] = [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lock", "bun"],   // text format (modern)
		["bun.lockb", "bun"],  // binary format (legacy)
		["package-lock.json", "npm"],
	];

	for (const [lockfile, pm] of lockfiles) {
		try {
			await access(path.join(projectRoot, lockfile));
			return pm;
		} catch {
			/* Not found */
		}
	}

	// Default to npm — it ships with every Node.js installation
	return "npm";
}

/**
 * Returns the dlx command for running a package without installing it.
 * e.g. pnpm dlx, npx, yarn dlx, bunx
 */
export function getDlxCommand(pm: PackageManager): [string, ...string[]] {
	switch (pm) {
		case "pnpm":
			return ["pnpm", "dlx"];
		case "yarn":
			return ["yarn", "dlx"];
		case "bun":
			return ["bunx"];
		case "npm":
			return ["npx"];
	}
}

/**
 * Returns the install command for adding a dependency.
 */
export function getInstallCommand(
	pm: PackageManager,
	pkg: string,
	dev = false
): [string, ...string[]] {
	switch (pm) {
		case "yarn":
			return dev ? ["yarn", "add", "-D", pkg] : ["yarn", "add", pkg];
		case "bun":
			return dev ? ["bun", "add", "-d", pkg] : ["bun", "add", pkg];
		case "npm":
			return dev
				? ["npm", "install", "-D", pkg]
				: ["npm", "install", pkg];
		case "pnpm":
			return dev ? ["pnpm", "add", "-D", pkg] : ["pnpm", "add", pkg];
	}
}

/**
 * Returns the run command prefix for executing package scripts.
 */
export function getRunCommand(pm: PackageManager): string {
	return pm === "npm" ? "npm run" : pm;
}

/**
 * On Windows, common JS package managers (npm, npx, pnpm, yarn, bun, bunx)
 * ship as `.cmd` shims rather than native `.exe` files. When `child_process`
 * is invoked without `shell: true`, Node skips PATHEXT resolution, so a
 * bare command name like `"npm"` fails to launch the shim.
 *
 * This helper appends `.cmd` on Windows when the input has no path separator
 * and no executable extension, letting callers drop `shell: true` (which is
 * deprecated in Node 24, DEP0190) without losing Windows compatibility.
 *
 * On non-Windows platforms, returns the input unchanged.
 *
 * Issue #16.
 */
export function resolveCommand(cmd: string): string {
	if (process.platform !== "win32") return cmd;
	if (cmd.includes("/") || cmd.includes("\\")) return cmd;
	if (/\.(exe|cmd|bat|ps1)$/i.test(cmd)) return cmd;
	return `${cmd}.cmd`;
}

/**
 * Checks whether a command exists on the system PATH.
 *
 * Internal callers only — `cmd` must be a static string. Probes via the
 * platform's native lookup binary (`where.exe` / `which`) instead of
 * spawning the command itself: on Windows, package managers are `.cmd`
 * shims, and Node >= 20.12 (CVE-2024-27980) refuses to spawn `.cmd`
 * files without `shell: true` (EINVAL) — while `shell: true` with an
 * args array is deprecated (DEP0190). `where`/`which` are native
 * executables, so they need neither.
 */
export function commandExists(cmd: string): boolean {
	const probe = process.platform === "win32" ? "where.exe" : "which";
	const result = spawnSync(probe, [cmd], { stdio: "pipe" });
	return result.status === 0;
}
