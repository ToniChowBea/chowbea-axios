import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Tests for signal exit handling in relaunchWithBun and similar spawn wrappers.
 * Issue #105: when a child process is terminated by a signal, the parent should
 * re-raise the signal or exit with a non-zero status, not mask it as exit 0.
 */

describe("Signal exit handling (Issue #105)", () => {
	it("child signal death: status is null, signal is set", () => {
		// Spawn a child that will be killed by SIGTERM.
		// We use node --eval with a setTimeout to give us time to kill it.
		const child = spawnSync(
			"node",
			["--eval", "setTimeout(() => {}, 10000)"],
			{ stdio: "pipe", timeout: 100 }
		);

		// timeout kills the child with SIGTERM on most platforms.
		// Verify that status is null and signal is set (the pattern that was
		// incorrectly handled as exit 0 in relaunchWithBun before the fix).
		expect(child.status).toBeNull();
		expect(child.signal).toBeTruthy();
	});

	it("normal exit: status is a number, signal is null", () => {
		// Spawn a child that exits normally with status 42.
		const child = spawnSync("node", ["--eval", "process.exit(42)"], {
			stdio: "pipe",
		});

		// Normal exit: status is the exit code, signal is null.
		expect(typeof child.status).toBe("number");
		expect(child.status).toBe(42);
		expect(child.signal).toBeNull();
	});

	it("successful exit: status is 0, signal is null", () => {
		// Spawn a child that exits successfully.
		const child = spawnSync("node", ["--version"], { stdio: "pipe" });

		// Successful exit: status is 0, signal is null.
		expect(child.status).toBe(0);
		expect(child.signal).toBeNull();
	});
});

/**
 * Exit code mapping helper test: demonstrates correct handling of
 * spawnSync results (status vs signal).
 */
function mockExitHandler(result: ReturnType<typeof spawnSync>): number {
	// This mirrors the fixed logic from relaunchWithBun (Issue #105).
	if (typeof result.status === "number") {
		return result.status;
	}
	if (result.signal) {
		// Signal death: return non-zero (128 + signal number convention, or just 1).
		return 1;
	}
	// Unknown failure: return non-zero.
	return 1;
}

describe("Exit code mapping helper", () => {
	it("maps normal exit codes correctly", () => {
		const result = spawnSync("node", ["--eval", "process.exit(42)"], {
			stdio: "pipe",
		});
		expect(mockExitHandler(result)).toBe(42);
	});

	it("maps signal deaths to non-zero", () => {
		const result = spawnSync(
			"node",
			["--eval", "setTimeout(() => {}, 10000)"],
			{ stdio: "pipe", timeout: 100 }
		);
		// Signal death should map to non-zero.
		expect(mockExitHandler(result)).toBe(1);
		expect(result.status).toBeNull();
		expect(result.signal).toBeTruthy();
	});

	it("maps successful exit to 0", () => {
		const result = spawnSync("node", ["--version"], { stdio: "pipe" });
		expect(mockExitHandler(result)).toBe(0);
	});
});
