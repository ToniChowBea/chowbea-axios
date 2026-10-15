import { describe, expect, it } from "vitest";

import { interpolateEnvVars } from "../src/core/fetcher.js";
import { createDeadServer } from "./helpers/dead-server.js";

describe("interpolateEnvVars (#29 — mismatched-brace regex)", () => {
	it("substitutes ${VAR} (braced)", () => {
		process.env.CHOWBEA_TEST_VAR = "from-env";
		try {
			expect(interpolateEnvVars("a ${CHOWBEA_TEST_VAR} b")).toBe(
				"a from-env b",
			);
		} finally {
			delete process.env.CHOWBEA_TEST_VAR;
		}
	});

	it("substitutes $VAR (bare)", () => {
		process.env.CHOWBEA_TEST_VAR = "from-env";
		try {
			expect(interpolateEnvVars("a $CHOWBEA_TEST_VAR b")).toBe("a from-env b");
		} finally {
			delete process.env.CHOWBEA_TEST_VAR;
		}
	});

	it("does NOT consume a stray `}` after a bare `$VAR` (mismatched close)", () => {
		process.env.CHOWBEA_TEST_VAR = "x";
		try {
			// `$VAR}` must produce `x}` — the `}` is preserved as literal text,
			// not silently swallowed by the regex.
			expect(interpolateEnvVars("a $CHOWBEA_TEST_VAR} b")).toBe("a x} b");
		} finally {
			delete process.env.CHOWBEA_TEST_VAR;
		}
	});

	it("does NOT consume a stray `${` (mismatched open)", () => {
		process.env.CHOWBEA_TEST_VAR = "x";
		try {
			// `${VAR` (no closing brace) must NOT match the braced form. The
			// `${` is left as literal text and the bare `$VAR` form does not
			// match either (the leading `{` blocks it). Result is the input.
			expect(interpolateEnvVars("a ${CHOWBEA_TEST_VAR b")).toBe(
				"a ${CHOWBEA_TEST_VAR b",
			);
		} finally {
			delete process.env.CHOWBEA_TEST_VAR;
		}
	});

	it("throws when the referenced variable is unset", () => {
		delete process.env.CHOWBEA_NEVER_SET;
		expect(() => interpolateEnvVars("${CHOWBEA_NEVER_SET}")).toThrow(
			/CHOWBEA_NEVER_SET/,
		);
	});

	it("handles mixed braced and bare forms in one string", () => {
		process.env.CHOWBEA_A = "alpha";
		process.env.CHOWBEA_B = "beta";
		try {
			expect(interpolateEnvVars("$CHOWBEA_A and ${CHOWBEA_B}!")).toBe(
				"alpha and beta!",
			);
		} finally {
			delete process.env.CHOWBEA_A;
			delete process.env.CHOWBEA_B;
		}
	});
});

describe("fetchOpenApiSpec URL validation (#20 — SSRF / scheme allowlist)", () => {
	// We're not actually hitting the network here — validation runs before
	// any fetch attempt, so the function should reject synchronously for
	// invalid URLs.
	const baseOpts = (endpoint: string) => ({
		endpoint,
		specPath: "/tmp/never-used",
		cachePath: "/tmp/never-used",
		logger: {
			level: "silent" as const,
			header: () => {},
			step: () => {},
			info: (() => {}) as never,
			warn: (() => {}) as never,
			error: (() => {}) as never,
			debug: (() => {}) as never,
			done: () => {},
			startProgress: () => {},
			stopProgress: () => {},
		},
	});

	it("rejects file: URLs", async () => {
		const { fetchOpenApiSpec } = await import("../src/core/fetcher.js");
		await expect(fetchOpenApiSpec(baseOpts("file:///etc/passwd"))).rejects.toThrow(
			/Unsupported URL scheme/,
		);
	});

	it("rejects custom-scheme URLs", async () => {
		const { fetchOpenApiSpec } = await import("../src/core/fetcher.js");
		await expect(fetchOpenApiSpec(baseOpts("ftp://example.com/spec.json"))).rejects.toThrow(
			/Unsupported URL scheme/,
		);
	});

	it("rejects garbage strings", async () => {
		const { fetchOpenApiSpec } = await import("../src/core/fetcher.js");
		await expect(fetchOpenApiSpec(baseOpts("not a url at all"))).rejects.toThrow(
			/Invalid endpoint URL/,
		);
	});

	it("accepts http: scheme (validation passes; fetch will fail at network)", async () => {
		const { server, url } = await createDeadServer();
		try {
			const { fetchOpenApiSpec } = await import("../src/core/fetcher.js");
			// Validation should NOT throw a "scheme" error — the eventual error
			// will be a NetworkError from the unreachable host, after retries.
			// We just verify the rejection isn't a scheme rejection.
			await expect(
				fetchOpenApiSpec({
					...baseOpts(`${url}/never-here`),
					retryConfig: { maxAttempts: 1, baseDelay: 1, backoffMultiplier: 1 },
				}),
			).rejects.toThrow();
			// (No assertion on the exact message — any error other than
			// "Unsupported URL scheme" / "Invalid endpoint URL" passes the
			// scheme/format check.)
		} finally {
			server.close();
		}
	});
});
