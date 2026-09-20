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
