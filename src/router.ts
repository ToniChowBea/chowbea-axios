import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { commandExists, resolveCommand } from "./core/pm.js";
import {
	decideDelegation,
	findRunningPackageRoot,
	resolveLocalInstall,
} from "./core/local-resolution.js";

/**
 * Check if Bun is available on the system.
 */
function hasBun(): boolean {
	return commandExists("bun");
}

/**
 * Re-launch the current script under Bun for TUI support.
 *
 * Either calls `process.exit` with the child's status (success path) or
 * returns `false` after logging the spawn failure — the caller can then
 * fall back to headless mode rather than silently exiting. Issue #45.
 */
function relaunchWithBun(argv: string[]): boolean {
	// Resolve the .ts entry point next to the .js one
	const thisFile = fileURLToPath(import.meta.url);
	const binDir = resolve(dirname(thisFile), "..", "bin");
	const tsEntry = resolve(binDir, "chowbea-axios.ts");

	// No `shell: true` — user argv flows through here, and shell metacharacters
	// in user-supplied args (e.g. paths from automation) would otherwise be
	// interpreted by the shell. resolveCommand handles Windows .cmd shims.
	// Issue #16.
	const result = spawnSync(resolveCommand("bun"), [tsEntry, ...argv.slice(2)], {
		stdio: "inherit",
		env: process.env,
	});

	if (result.error) {
		console.error(
			`Failed to relaunch under Bun: ${result.error.message}\n` +
				"Falling back to headless mode.",
		);
		return false;
	}
	process.exit(result.status ?? 0);
}

/**
 * Local-first execution. If the working directory has its own chowbea-axios
 * install and we are NOT it (i.e. the global one is running), hand off to the
 * project-local bin so the pinned version runs. Mirrors relaunchWithBun: on
 * delegation the child runs to completion and we exit with its status; if the
 * spawn itself fails we warn and continue with the current process.
 */
function maybeDelegateToLocal(argv: string[]): void {
	const decision = decideDelegation({
		runningRoot: findRunningPackageRoot(import.meta.url),
		localInstall: resolveLocalInstall(process.cwd()),
		argv,
		env: process.env,
	});
	if (decision.action !== "delegate") return;

	// No `shell: true` — user argv flows through unescaped. The sentinel env var
	// stops the delegated child from delegating back. Issue #16.
	const result = spawnSync(
		process.execPath,
		[decision.binPath, ...argv.slice(2)],
		{
			stdio: "inherit",
			env: { ...process.env, CHOWBEA_LOCAL_DELEGATED: "1" },
		},
	);

	if (result.error) {
		console.error(
			`chowbea: could not run the project-local install ` +
				`(${result.error.message}); continuing with the global one.`,
		);
		return;
	}
	if (typeof result.status === "number") {
		process.exit(result.status);
	}
	if (result.signal) {
		// The child was killed by a signal — re-raise it so we terminate the
		// same way instead of masking it as a clean (exit 0) success.
		process.kill(process.pid, result.signal);
		return;
	}
	process.exit(1);
}

/**
 * Command router -- dispatches to TUI dashboard or headless CLI.
 */
export async function route(argv: string[]): Promise<void> {
	// Local-first: hand off to a project-local install before anything else.
	maybeDelegateToLocal(argv);

	const args = argv.slice(2); // strip runtime and script path
	const command = args.find((a) => !a.startsWith("-"));
	const hasFlag =
		args.includes("--version") ||
		args.includes("-h") ||
		args.includes("--help") ||
		args.includes("--headless");
	const isHeadless = !process.stdout.isTTY || !process.stdin.isTTY || hasFlag;

	if (!command && !isHeadless) {
		// Already running under Bun — import TUI directly
		const isBunRuntime = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

		if (isBunRuntime) {
			const { launchDashboard } = await import("./tui/main.js");
			await launchDashboard();
			return;
		}

		// Running under Node — try to re-launch with Bun. On success the
		// child process exits and never returns; on failure we fall through
		// to headless help with a clear message (#45).
		if (hasBun()) {
			const launched = relaunchWithBun(argv);
			if (launched) return; // unreachable — process.exit on success
			// fall through to headless on failure
		} else {
			// No Bun available — print the requires-Bun notice once and
			// return. Falling through to `runHeadless(undefined, args)` would
			// produce confusing dual output (#45).
			console.log(
				"TUI dashboard requires Bun. Install Bun (https://bun.sh) or use headless mode:\n" +
					"  chowbea <command>\n",
			);
			return;
		}
	}

	// Headless CLI mode
	const { runHeadless } = await import("./headless/runner.js");
	await runHeadless(command, args);
}
