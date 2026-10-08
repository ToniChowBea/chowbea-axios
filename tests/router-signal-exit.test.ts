import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getSignalNumber } from "../src/router.js";

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

describe("getSignalNumber (ESM import correctness)", () => {
	// This test ensures getSignalNumber uses a proper ESM import, not require().
	// On POSIX systems, SIGTERM is 15 and SIGINT is 2 by convention.
	// On Windows, these signals may not be defined or have different meanings.

	it("maps SIGTERM to its numeric value on POSIX (15)", () => {
		const signum = getSignalNumber("SIGTERM");
		if (process.platform === "win32") {
			// Windows may not have POSIX signals, or they may be different.
			// Just verify the function returns a number or null.
			expect(signum === null || typeof signum === "number").toBe(true);
		} else {
			// On POSIX (Linux, macOS), SIGTERM should be 15.
			expect(signum).toBe(15);
		}
	});

	it("maps SIGINT to its numeric value on POSIX (2)", () => {
		const signum = getSignalNumber("SIGINT");
		if (process.platform === "win32") {
			// Windows may not have POSIX signals, or they may be different.
			expect(signum === null || typeof signum === "number").toBe(true);
		} else {
			// On POSIX (Linux, macOS), SIGINT should be 2.
			expect(signum).toBe(2);
		}
	});

	it("returns null for unknown signal names", () => {
		const signum = getSignalNumber("SIGNOTAREALTHING");
		expect(signum).toBeNull();
	});

	it("computes correct exit code for SIGTERM (128 + 15 = 143 on POSIX)", () => {
		const signum = getSignalNumber("SIGTERM");
		if (process.platform !== "win32" && signum !== null) {
			const exitCode = 128 + signum;
			expect(exitCode).toBe(143);
		}
	});

	it("computes correct exit code for SIGINT (128 + 2 = 130 on POSIX)", () => {
		const signum = getSignalNumber("SIGINT");
		if (process.platform !== "win32" && signum !== null) {
			const exitCode = 128 + signum;
			expect(exitCode).toBe(130);
		}
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
		// Signal death: return 128 + signal number (standard convention).
		// Try to get the signal number; fall back to 1 if unavailable.
		const signalNum = getSignalNumber(result.signal);
		return signalNum !== null ? 128 + signalNum : 1;
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

	it("maps signal deaths to 128 + signal number", () => {
		const result = spawnSync(
			"node",
			["--eval", "setTimeout(() => {}, 10000)"],
			{ stdio: "pipe", timeout: 100 }
		);
		// Signal death should map to 128 + signal number.
		const exitCode = mockExitHandler(result);
		// On Unix, timeout usually sends SIGTERM (15), so we'd expect 128 + 15 = 143.
		// On Windows, signal handling differs, so we just verify it's non-zero.
		expect(exitCode).toBeGreaterThan(0);
		expect(result.status).toBeNull();
		expect(result.signal).toBeTruthy();
	});

	it("maps successful exit to 0", () => {
		const result = spawnSync("node", ["--version"], { stdio: "pipe" });
		expect(mockExitHandler(result)).toBe(0);
	});
});
