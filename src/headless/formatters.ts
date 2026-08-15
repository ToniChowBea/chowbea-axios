/**
 * Plain text output formatters for headless mode.
 * Extracts the status/diff display logic from the old oclif commands
 * so it can be used by the headless runner.
 */

import pc from "picocolors";
import type { StatusResult } from "../core/actions/status.js";
import { formatTimeAgo } from "../core/actions/status.js";
import type { DiffResult } from "../core/actions/diff.js";
import type { PluginsResult } from "../core/actions/plugins.js";

/** Indentation for sub-messages under a step (14 spaces). */
const INDENT = "              ";

/** Padding for step labels (right-padded). */
const LABEL_WIDTH = 10;

/**
 * Pads a label to a fixed width for alignment.
 */
function pad(label: string): string {
	return label.padEnd(LABEL_WIDTH);
}

/**
 * Formats the status result as a colored string for terminal output.
 * Replicates the printStatus method from commands/status.ts.
 */
export function formatStatusOutput(result: StatusResult): string {
	const lines: string[] = [];
	const yes = pc.green("yes");
	const no = pc.red("no");
	const missing = pc.red("missing");

	lines.push("");
	lines.push(`  ${pc.bold("chowbea status")}`);
	lines.push("");

	// Which install is running — project-local vs global.
	const runLabel =
		result.executionSource === "project"
			? pc.green("project install")
			: pc.dim("global install");
	lines.push(
		`  ${pc.cyan("●")} ${pc.bold(pc.cyan(pad("running")))}${runLabel}`,
	);
	lines.push("");

	// Config section
	lines.push(
		`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("config")))}${result.configPath}${result.wasCreated ? pc.yellow(" (created)") : ""}`,
	);
	lines.push(
		`${INDENT}${pc.dim("endpoint:")} ${pc.cyan(result.endpoint)}`,
	);
	lines.push(
		`${INDENT}${pc.dim("output:")} ${pc.cyan(result.outputFolder)}`,
	);
	lines.push("");

	// Spec section
	if (result.specExists && result.cacheMetadata) {
		const cachedAgo = formatTimeAgo(
			new Date(result.cacheMetadata.timestamp),
		);
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${yes} ${pc.dim(`(hash: ${result.cacheMetadata.hash.slice(0, 8)}, ${cachedAgo})`)}`,
		);
	} else if (result.specExists) {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${yes} ${pc.dim("(no metadata)")}`,
		);
	} else {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("spec")))}${pc.dim("cached:")} ${no} ${pc.dim("- run 'chowbea fetch' first")}`,
		);
	}

	// Endpoint statistics — render only the method buckets that have
	// non-zero counts, in canonical order. Includes OPTIONS/HEAD/TRACE
	// for issue #31.
	if (result.methodCounts && result.methodCounts.total > 0) {
		lines.push(
			`${INDENT}${pc.dim("endpoints:")} ${pc.yellow(String(result.methodCounts.total))} total`,
		);
		const methods: string[] = [];
		const ordered: Array<[keyof typeof result.methodCounts, string]> = [
			["get", "GET"],
			["post", "POST"],
			["put", "PUT"],
			["patch", "PATCH"],
			["delete", "DELETE"],
			["options", "OPTIONS"],
			["head", "HEAD"],
			["trace", "TRACE"],
		];
		for (const [key, label] of ordered) {
			const count = result.methodCounts[key];
			if (typeof count === "number" && count > 0) {
				methods.push(`${label}: ${pc.yellow(String(count))}`);
			}
		}
		lines.push(`${INDENT}${methods.join("  ")}`);
	}
	lines.push("");

	// Generated files section
	const { types, operations } = result.fileStatus;
	lines.push(
		`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("generated")))}${pc.dim("types:")} ${types?.exists ? `${yes}${types.modifiedAgo ? ` ${pc.dim(`(${types.modifiedAgo})`)}` : ""}` : no}`,
	);
	lines.push(
		`${INDENT}${pc.dim("operations:")} ${operations?.exists ? `${yes}${operations.modifiedAgo ? ` ${pc.dim(`(${operations.modifiedAgo})`)}` : ""}` : no}`,
	);
	lines.push("");

	// Client files section
	const clientFiles = ["helpers", "instance", "error", "client"];
	const allPresent = clientFiles.every(
		(f) => result.fileStatus[f]?.exists,
	);
	const nonePresent = clientFiles.every(
		(f) => !result.fileStatus[f]?.exists,
	);

	if (allPresent) {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}all present`,
		);
	} else if (nonePresent) {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}${missing} ${pc.dim("- run 'chowbea init' or 'chowbea generate'")}`,
		);
	} else {
		let first = true;
		for (const file of clientFiles) {
			const status = result.fileStatus[file];
			const value = status?.exists
				? `${yes}${status.modifiedAgo ? ` ${pc.dim(`(${status.modifiedAgo})`)}` : ""}`
				: missing;
			if (first) {
				lines.push(
					`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("client")))}${file}: ${value}`,
				);
				first = false;
			} else {
				lines.push(`${INDENT}${file}: ${value}`);
			}
		}
	}

	lines.push("");
	return lines.join("\n");
}

/**
 * Formats the diff result as a colored string for terminal output.
 * Replicates the diff display logic from commands/diff.ts.
 */
export function formatDiffSummary(result: DiffResult): string {
	const lines: string[] = [];

	if (result.identical) {
		lines.push(
			`  ${pc.green("\u2713")} Spec is identical to cached version - no changes`,
		);
		return lines.join("\n");
	}

	if (
		result.added.length === 0 &&
		result.removed.length === 0 &&
		result.modified.length === 0
	) {
		lines.push(
			`  ${pc.green("\u2713")} No changes to operations detected`,
		);
		return lines.join("\n");
	}

	if (result.added.length > 0) {
		lines.push(`\n${pc.green(`+ Added operations (${result.added.length}):`)}`);
		for (const op of result.added) {
			lines.push(
				`  ${pc.green(`+ ${op.method.toUpperCase()} ${op.path} (${op.operationId})`)}`,
			);
		}
	}

	if (result.removed.length > 0) {
		lines.push(`\n${pc.red(`- Removed operations (${result.removed.length}):`)}`);
		for (const op of result.removed) {
			lines.push(
				`  ${pc.red(`- ${op.method.toUpperCase()} ${op.path} (${op.operationId})`)}`,
			);
		}
	}

	if (result.modified.length > 0) {
		lines.push(
			`\n${pc.yellow(`~ Modified operations (${result.modified.length}):`)}`);
		for (const { old: oldOp, new: newOp } of result.modified) {
			lines.push(
				`  ${pc.yellow(`~ ${newOp.method.toUpperCase()} ${newOp.path} (${newOp.operationId})`)}`,
			);
			if (oldOp.hasRequestBody !== newOp.hasRequestBody) {
				lines.push(
					`    ${pc.dim("Request body:")} ${oldOp.hasRequestBody} -> ${newOp.hasRequestBody}`,
				);
			}
			if (oldOp.summary !== newOp.summary) {
				lines.push(`    ${pc.dim("Summary changed")}`);
			}
		}
	}

	lines.push("");
	lines.push(
		`  ${pc.bold(`${result.added.length} added, ${result.removed.length} removed, ${result.modified.length} modified`)}`,
	);
	lines.push(
		`  ${pc.dim("Run 'chowbea fetch' to apply these changes")}`,
	);

	return lines.join("\n");
}

/**
 * Formats the plugins scan result as a colored string for terminal output.
 * Groups surfaces and panels by their group field with indentation.
 */
export function formatPluginsList(result: PluginsResult): string {
	const lines: string[] = [];

	lines.push("");
	lines.push(`  ${pc.bold("chowbea plugins")}`);
	lines.push("");

	// Surfaces section
	if (!result.surfacesConfigured) {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("surfaces")))}${pc.red("not configured")} ${pc.dim("- run 'chowbea plugins --setup'")}`,
		);
	} else {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("surfaces")))}${pc.dim("dir:")} ${pc.cyan(result.surfacesDir ?? "n/a")}  ${pc.dim("count:")} ${pc.yellow(String(result.surfaces.length))}`,
		);

		if (result.surfaces.length > 0) {
			for (const group of result.surfaceGroups) {
				const groupLabel = group || "(root)";
				const items = result.surfaces.filter((s) => s.group === group);
				if (items.length === 0) continue;

				lines.push(`${INDENT}${pc.dim(groupLabel)}`);
				for (const s of items) {
					const meta = [
						pc.dim(`variant:${s.variant}`),
						s.defaultProps.length > 0
							? pc.dim(`props:[${s.defaultProps.join(",")}]`)
							: null,
					]
						.filter(Boolean)
						.join("  ");
					lines.push(`${INDENT}  ${pc.green(s.id)} ${meta}`);
				}
			}
		}
	}
	lines.push("");

	// Panels section
	if (!result.sidepanelsConfigured) {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("panels")))}${pc.red("not configured")} ${pc.dim("- run 'chowbea plugins --setup'")}`,
		);
	} else {
		lines.push(
			`  ${pc.cyan("\u25cf")} ${pc.bold(pc.cyan(pad("panels")))}${pc.dim("dir:")} ${pc.cyan(result.sidepanelsDir ?? "n/a")}  ${pc.dim("count:")} ${pc.yellow(String(result.panels.length))}`,
		);

		if (result.panels.length > 0) {
			for (const group of result.panelGroups) {
				const groupLabel = group || "(root)";
				const items = result.panels.filter((p) => p.group === group);
				if (items.length === 0) continue;

				lines.push(`${INDENT}${pc.dim(groupLabel)}`);
				for (const p of items) {
					const meta = [
						p.contextParams.length > 0
							? pc.dim(`context:[${p.contextParams.join(",")}]`)
							: null,
						p.routeParams.length > 0
							? pc.dim(`routes:[${p.routeParams.join(",")}]`)
							: null,
					]
						.filter(Boolean)
						.join("  ");
					lines.push(`${INDENT}  ${pc.green(p.id)} ${meta}`);
				}
			}
		}
	}

	lines.push("");
	return lines.join("\n");
}
