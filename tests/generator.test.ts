import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { runClientFiles, runGenerator } from "./helpers/run-generator.js";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

async function loadFixture(name: string): Promise<object> {
	const url = new URL(name, FIXTURE_DIR);
	return JSON.parse(await readFile(url, "utf8"));
}

describe("generator: end-to-end snapshots", () => {
	it("petstore — clean canonical spec", async () => {
		const spec = await loadFixture("petstore.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatchSnapshot("api.operations.ts");
			expect(contracts).toMatchSnapshot("api.contracts.ts");
		} finally {
			await cleanup();
		}
	});

	it("edge-cases — kebab/snake collision, JSDoc/enum injection, recursion, additionalProperties, HEAD method, multipart heuristic", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatchSnapshot("api.operations.ts");
			expect(contracts).toMatchSnapshot("api.contracts.ts");
		} finally {
			await cleanup();
		}
	});

	it("#119: named string enums emit a runtime const object + derived union; mixed enums stay union-only", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "Enums", version: "1.0.0" },
			paths: {
				"/actions": {
					get: {
						operationId: "listActions",
						responses: {
							"200": {
								description: "ok",
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/Action" },
									},
								},
							},
						},
					},
				},
			},
			components: {
				schemas: {
					Action: {
						type: "string",
						enum: ["invalidate", "refresh", "hub.mode"],
					},
					Mixed: { enum: ["a", 1, null] },
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// The plain union alias is unchanged — the const is purely additive.
			expect(contracts).toContain(
				'export type Action = "invalidate" | "refresh" | "hub.mode";',
			);
			// Runtime const with value-keyed entries; non-identifier keys quoted.
			expect(contracts).toContain("export const Action = {");
			expect(contracts).toContain('\tinvalidate: "invalidate",');
			expect(contracts).toContain('\t"hub.mode": "hub.mode",');
			// Mixed (non-all-string) enums stay a plain union type, no const.
			expect(contracts).toContain('export type Mixed = "a" | 1 | null;');
			expect(contracts).not.toContain("export const Mixed");
		} finally {
			await cleanup();
		}
	});

	it("operations header omits the volatile 'Total operations' stat (merge-conflict noise)", async () => {
		const spec = await loadFixture("petstore.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			expect(operations).not.toContain("Total operations");
		} finally {
			await cleanup();
		}
	});
});

describe("generator: client files (api.helpers.ts, api.instance.ts, api.error.ts, api.client.ts)", () => {
	it("default instance config snapshot", async () => {
		const { helpers, instance, error, client, cleanup } =
			await runClientFiles();
		try {
			expect(helpers).toMatchSnapshot("api.helpers.ts");
			expect(instance).toMatchSnapshot("api.instance.ts");
			expect(error).toMatchSnapshot("api.error.ts");
			expect(client).toMatchSnapshot("api.client.ts");
		} finally {
			await cleanup();
		}
	});

	it("auth_mode=bearer-localstorage emits a tokenKey constant", async () => {
		const { instance, cleanup } = await runClientFiles({
			auth_mode: "bearer-localstorage",
			token_key: "my-token-key",
		});
		try {
			expect(instance).toMatch(/export const tokenKey = "my-token-key";/);
			expect(instance).toMatch(/localStorage\.getItem\(tokenKey\)/);
		} finally {
			await cleanup();
		}
	});

	it("auth_mode=none emits no auth interceptor", async () => {
		const { instance, cleanup } = await runClientFiles({
			auth_mode: "none",
		});
		try {
			expect(instance).not.toMatch(/interceptors\.request\.use/);
			expect(instance).not.toMatch(/Authorization/);
		} finally {
			await cleanup();
		}
	});

	it("with_credentials propagates literally to axios.create", async () => {
		const { instance, cleanup } = await runClientFiles({
			with_credentials: false,
		});
		try {
			expect(instance).toMatch(/withCredentials: false,/);
		} finally {
			await cleanup();
		}
	});
});

describe("generator: known-bug regression markers", () => {
	// These tests document bugs reported in the package review (#13–#22).
	// They are written in a form that will FAIL once the bugs are fixed,
	// at which point each `.fails` should flip to a positive assertion in
	// the same PR that ships the fix. This keeps the test file as a record
	// of which bugs are still latent vs resolved.

	it("#13 (FIXED): operation keys with `-` are quoted in api.operations.ts", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			// Bare `get-user:` would be invalid TS; quoted `"get-user":` is correct.
			expect(operations).not.toMatch(/^\s+get-user:/m);
			expect(operations).toMatch(/^\s+"get-user":/m);
			// Also covers the other dashed operationIds in the fixture.
			// (`head-user` is excluded — HEAD method is skipped by the generator
			// today; that's tracked separately as issue #31.)
			expect(operations).toMatch(/^\s+"list-items":/m);
			expect(operations).toMatch(/^\s+"create-item":/m);
			expect(operations).toMatch(/^\s+"upload-file":/m);
			expect(operations).toMatch(/^\s+"get-dictionary":/m);
		} finally {
			await cleanup();
		}
	});

	it("#14 (FIXED): descriptions containing `*/` do not break JSDoc comments", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, operations, cleanup } = await runGenerator(spec);
		try {
			// The fixture's User schema description is:
			//   "A user. Description containing */ injection attempt — issue #14."
			// Pre-fix, the unescaped `*/` closed the JSDoc block early and the
			// trailing text leaked into code position. Post-fix, the entire
			// description is preserved with `*/` rewritten to `*\/`, and no
			// part of the description appears outside a comment.
			//
			// Specific assertions:
			// - The escaped form `*\/` appears (proving the helper ran).
			expect(contracts).toMatch(/\*\\\//);
			// - The danger string after the `*/` (`injection attempt`) never
			//   appears as bare code — only as part of a comment line that
			//   begins with whitespace and `*` (the `*` of the JSDoc body).
			const checkLeak = (body: string) => {
				const leakingLines = body
					.split("\n")
					.filter((line) => /injection attempt/.test(line))
					.filter((line) => !/^\s*\*\s/.test(line));
				expect(leakingLines).toEqual([]);
			};
			checkLeak(contracts);
			checkLeak(operations);
		} finally {
			await cleanup();
		}
	});

	it("#17 (FIXED): generateInstanceFileContent rejects malicious env_accessor", async () => {
		const { generateInstanceFileContent } = await import(
			"../src/core/generator.js"
		);
		const { DEFAULT_INSTANCE_CONFIG } = await import(
			"../src/core/config.js"
		);
		expect(() =>
			generateInstanceFileContent({
				...DEFAULT_INSTANCE_CONFIG,
				env_accessor: 'process.env); throw new Error("pwn"); //',
			}),
		).toThrow(/Invalid env_accessor/);
	});

	it("#17 (FIXED): generateInstanceFileContent rejects malicious base_url_env", async () => {
		const { generateInstanceFileContent } = await import(
			"../src/core/generator.js"
		);
		const { DEFAULT_INSTANCE_CONFIG } = await import(
			"../src/core/config.js"
		);
		expect(() =>
			generateInstanceFileContent({
				...DEFAULT_INSTANCE_CONFIG,
				base_url_env: 'API_URL; require("fs").writeFileSync("/tmp/pwn", "x"); var x = "',
			}),
		).toThrow(/Invalid base_url_env/);
	});

	it("#17 (FIXED): generateInstanceFileContent emits tokenKey via JSON.stringify so quotes/backslashes can't escape the literal", async () => {
		const { generateInstanceFileContent } = await import(
			"../src/core/generator.js"
		);
		const { DEFAULT_INSTANCE_CONFIG } = await import(
			"../src/core/config.js"
		);
		const out = generateInstanceFileContent({
			...DEFAULT_INSTANCE_CONFIG,
			auth_mode: "bearer-localstorage",
			token_key: 'foo"; throw 0; var x = "bar',
		});
		// The dangerous payload must appear escaped inside a single string
		// literal. JSON.stringify escapes the embedded `"` to `\"`, so the
		// literal stays intact end-to-end.
		expect(out).toMatch(/export const tokenKey = "foo\\"; throw 0; var x = \\"bar";/);
		// And there should be exactly one `tokenKey =` in the file (not two —
		// which would happen if the payload broke out of the literal and
		// declared its own).
		const tokenKeyMatches = out.match(/tokenKey\s*=/g) ?? [];
		expect(tokenKeyMatches).toHaveLength(1);
	});

	it("#15 (FIXED): enum string values containing `\"` or `\\` are properly escaped", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Spec enum: ["a\"b", "c\\d", "normal"]
			// Should emit JSON.stringify-escaped TS literals: "a\"b" | "c\\d" | "normal"
			expect(contracts).toMatch(/"a\\"b"/);
			expect(contracts).toMatch(/"c\\\\d"/);
			expect(contracts).toMatch(/"normal"/);
		} finally {
			await cleanup();
		}
	});

	it("#18 (FIXED): distinct operationIds that sanitize to the same identifier throw at generate time", async () => {
		// `get-user` and `get_user` both sanitize to `get_user`.
		const spec = {
			openapi: "3.0.3",
			info: { title: "Collision", version: "1.0.0" },
			paths: {
				"/users": {
					get: {
						operationId: "get-user",
						responses: { "200": { description: "OK" } },
					},
					post: {
						operationId: "get_user",
						responses: { "200": { description: "OK" } },
					},
				},
			},
		};
		await expect(runGenerator(spec)).rejects.toThrow(
			/OperationId collision/,
		);
	});

	it("#18 (FIXED): collision error names every colliding pair", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "Collision", version: "1.0.0" },
			paths: {
				"/a": {
					get: { operationId: "do-thing", responses: { "200": { description: "OK" } } },
					post: { operationId: "do_thing", responses: { "200": { description: "OK" } } },
				},
				"/b": {
					get: { operationId: "list a b", responses: { "200": { description: "OK" } } },
					post: { operationId: "list-a-b", responses: { "200": { description: "OK" } } },
				},
			},
		};
		await expect(runGenerator(spec)).rejects.toThrow(/do-thing.*do_thing/s);
		await expect(runGenerator(spec)).rejects.toThrow(/list a b.*list-a-b/s);
	});

	it("#18 (FIXED): unique operationIds still generate cleanly", async () => {
		const spec = await loadFixture("petstore.json");
		const { operations, contracts, cleanup } = await runGenerator(spec);
		try {
			// Sanity: petstore has no collisions, so generation succeeds.
			expect(operations.length).toBeGreaterThan(0);
			expect(contracts.length).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it("#26 (FIXED): recursive types reference themselves instead of collapsing to unknown[]", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// `User.friends` recurses into User; on the cycle we now emit
			// the sanitized name, which the contracts file already exports
			// as a top-level interface.
			expect(contracts).not.toMatch(/friends\?:\s*unknown\[\]/);
			expect(contracts).toMatch(/friends\?:\s*User\[\]/);
		} finally {
			await cleanup();
		}
	});

	it("#31 (FIXED): HEAD/OPTIONS/TRACE operations ARE emitted in api.operations.ts", async () => {
		// The runtime client now has typed wrappers for all 8 OpenAPI
		// methods, so the generator emits operations for them too.
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatch(/"head-user":/);
			// And the emitted call routes through the runtime client's head method.
			expect(operations).toMatch(/apiClient\.head\(/);
		} finally {
			await cleanup();
		}
	});

	it("#31 (FIXED): generator emits OPTIONS and TRACE wrappers when present in spec", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/x": {
					options: { operationId: "preflight-x", responses: { "200": { description: "OK" } } },
					trace: { operationId: "trace-x", responses: { "200": { description: "OK" } } },
				},
			},
		};
		const { operations, cleanup } = await runGenerator(spec);
		try {
			expect(operations).toMatch(/"preflight-x":/);
			expect(operations).toMatch(/"trace-x":/);
			expect(operations).toMatch(/apiClient\.options\(/);
			expect(operations).toMatch(/apiClient\.trace\(/);
		} finally {
			await cleanup();
		}
	});

	it("#32 (FIXED): additionalProperties produces a Record<string, T> intersection", async () => {
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// `/dictionary` GET response has additionalProperties: { type: string }
			// alongside a named `id` property. The emitted type combines
			// `{ id?: string }` with `Record<string, string>`.
			expect(contracts).toMatch(/Record<string,\s*string>/);
		} finally {
			await cleanup();
		}
	});

	it("#32 (FIXED): additionalProperties: true emits Record<string, unknown>", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/x": {
					get: {
						operationId: "get-x",
						responses: {
							"200": {
								description: "OK",
								content: {
									"application/json": {
										schema: {
											type: "object",
											additionalProperties: true,
										},
									},
								},
							},
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			expect(contracts).toMatch(/Record<string,\s*unknown>/);
		} finally {
			await cleanup();
		}
	});

	it("#32 (FIXED): additionalProperties: false leaves a closed object", async () => {
		const spec = {
			openapi: "3.0.3",
			info: { title: "X", version: "1.0.0" },
			paths: {
				"/x": {
					get: {
						operationId: "get-x",
						responses: {
							"200": {
								description: "OK",
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: { id: { type: "string" } },
											additionalProperties: false,
										},
									},
								},
							},
						},
					},
				},
			},
		};
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			// Closed shape — no Record intersection emitted.
			expect(contracts).toMatch(/Get_xResponse200 = \{[^&]*\};/s);
			expect(contracts).not.toMatch(/Get_xResponse200.*Record</s);
		} finally {
			await cleanup();
		}
	});

	it("Schema Model name colliding with operation body name emits only one declaration", async () => {
		// Regression: when `components.schemas.X` exists AND an operationId
		// pascal-cases to `XBody` (e.g. schema `PingBody` + operation `ping`
		// whose body type would also be named `PingBody`), the generator
		// previously emitted two top-level declarations of the same name,
		// which is a TS2300 hard error at compile time. The fix is to track
		// already-declared names and skip duplicates in the later passes.
		const spec = await loadFixture("edge-cases.json");
		const { contracts, cleanup } = await runGenerator(spec);
		try {
			const matches = contracts.match(/^export (?:interface|type) PingBody\b/gm) ?? [];
			expect(matches).toHaveLength(1);
			// The skipped duplicate leaves an explanatory comment so the
			// reader can find the canonical declaration.
			expect(contracts).toMatch(
				/Request body: POST \/ping — name already declared as a Schema Model above; skipped\./,
			);
		} finally {
			await cleanup();
		}
	});

	it("body-less POST/PUT operations emit `undefined` in the data slot", async () => {
		// Regression: POST and PUT share PATCH's `(url, data, ...args)` runtime
		// signature. When an op has no requestBody, the generator must still
		// pass `undefined` as the data arg — otherwise pathParams gets sent as
		// the JSON request body. The earlier code only special-cased PATCH.
		const spec = await loadFixture("edge-cases.json");
		const { operations, cleanup } = await runGenerator(spec);
		try {
			// Body-less POST with path params.
			expect(operations).toMatch(
				/"publish-item":[^=]*=>\s*apiClient\.post\("\/items\/\{id\}\/publish",\s*undefined,\s*pathParams,\s*config\)/,
			);
			// Body-less PUT with path params.
			expect(operations).toMatch(
				/"archive-item":[^=]*=>\s*apiClient\.put\("\/items\/\{id\}\/archive",\s*undefined,\s*pathParams,\s*config\)/,
			);
			// Negative assertion: pathParams must NOT be passed in the data slot.
			expect(operations).not.toMatch(
				/apiClient\.post\("\/items\/\{id\}\/publish",\s*pathParams/,
			);
			expect(operations).not.toMatch(
				/apiClient\.put\("\/items\/\{id\}\/archive",\s*pathParams/,
			);
		} finally {
			await cleanup();
		}
	});
});
