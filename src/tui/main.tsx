import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app.js";
import { findProjectRoot } from "../core/config.js";
import {
	commandExists,
	detectPackageManager,
	getInstallCommand,
	resolveCommand,
	safeSpawnSync,
} from "../core/pm.js";

/**
 * Checks whether a file or directory exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks if a package exists in node_modules.
 */
async function packageExists(
	projectRoot: string,
	pkg: string,
): Promise<boolean> {
	try {
		await access(
			path.join(projectRoot, "node_modules", pkg, "package.json"),
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Installs a single package using the detected package manager.
 */
async function installPackage(
	projectRoot: string,
	pkg: string,
	dev: boolean,
): Promise<void> {
	console.log(`Installing ${pkg}...`);
	const pm = await detectPackageManager(projectRoot);
	// Use safeSpawnSync to handle Windows .cmd shims correctly (Node >= 20.12
	// refuses to spawn .cmd files without shell: true, returning EINVAL). Issue #144.
	const [cmd, ...args] = getInstallCommand(pm, pkg, dev);
	safeSpawnSync(resolveCommand(cmd), args, {
		cwd: projectRoot,
		stdio: "inherit",
		timeout: 60_000,
	});
}

/**
 * Ensures all required project-level dependencies are installed
 * before launching the TUI dashboard.
 */
async function ensureProjectDependencies(): Promise<void> {
	try {
		const projectRoot = await findProjectRoot();

		// 1. Run a general install if node_modules doesn't exist
		const nodeModulesExists = await fileExists(
			path.join(projectRoot, "node_modules"),
		);
		if (!nodeModulesExists) {
			console.log("Installing project dependencies...");
			const pm = await detectPackageManager(projectRoot);
			// Verify PM binary exists
			if (!commandExists(pm)) {
				console.error(
					`Package manager "${pm}" not found. Please install it first.`,
				);
				process.exit(1);
			}
			// Use safeSpawnSync to handle Windows .cmd shims correctly (Node >= 20.12
			// refuses to spawn .cmd files without shell: true, returning EINVAL). Issue #144.
			safeSpawnSync(resolveCommand(pm), ["install"], {
				cwd: projectRoot,
				stdio: "inherit",
				timeout: 120_000,
			});
		}

		// 2. Read package.json for specific checks
		const packageJsonPath = path.join(projectRoot, "package.json");
		let packageJson: Record<string, unknown>;
		try {
			const content = await readFile(packageJsonPath, "utf8");
			packageJson = JSON.parse(content) as Record<string, unknown>;
		} catch {
			return; // No package.json — nothing to check
		}

		const deps = (packageJson.dependencies ?? {}) as Record<string, string>;
		const scripts = (packageJson.scripts ?? {}) as Record<string, string>;

		// 3. Ensure axios is installed
		if (deps.axios && !(await packageExists(projectRoot, "axios"))) {
			await installPackage(projectRoot, "axios", false);
		}

		// 4. Ensure concurrently if scripts use it
		const usesConcurrently = Object.values(scripts).some((cmd) =>
			cmd.includes("concurrently"),
		);
		if (
			usesConcurrently &&
			!(await packageExists(projectRoot, "concurrently"))
		) {
			await installPackage(projectRoot, "concurrently", true);
		}
	} catch {
		// Non-fatal — the TUI will still launch
	}
}

export async function launchDashboard(): Promise<void> {
	await ensureProjectDependencies();

	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
	});
	createRoot(renderer).render(<App />);
}
