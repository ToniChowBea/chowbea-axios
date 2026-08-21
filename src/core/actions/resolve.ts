/**
 * `resolve` action — resolve merge conflicts in committed generated files by
 * regenerating them from the spec.
 *
 * The files under `_generated/` are a pure projection of the OpenAPI spec, so
 * they aren't meaningfully text-mergeable: the only correct post-merge content
 * is a fresh regeneration. `resolve` finds generated files left in a conflict
 * state, regenerates them from the cached/local spec, and stages the result —
 * turning an unreadable multi-thousand-line conflict into one command.
 */

import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { getOutputPaths, loadConfig } from "../config.js";
import { isGitRepo, listUnmergedFiles, stageFiles } from "../git.js";
import { executeGenerate } from "./generate.js";

export interface ResolveActionOptions {
	configPath?: string;
}

export interface ResolveResult {
	isGitRepo: boolean;
	/** Conflicted files under `_generated/` (regenerated). */
	conflictedGenerated: string[];
	/** Conflicted files elsewhere — still need manual resolution. */
	conflictedOther: string[];
	/** Whether the generator was run to overwrite the conflicts. */
	regenerated: boolean;
	/** Repo-relative paths staged after regeneration. */
	staged: string[];
}

/**
 * Split a list of conflicted (unmerged) repo-relative paths into those under
 * the generated directory (auto-resolvable by regenerating) and everything
 * else (which still needs manual resolution). Path separators are normalised
 * to `/` to match git's output on every platform.
 */
export function partitionConflicts(
	unmerged: string[],
	generatedRel: string,
): { generated: string[]; other: string[] } {
	const normalized = generatedRel.replace(/\\/g, "/").replace(/\/+$/, "");
	const prefix = `${normalized}/`;
	const generated: string[] = [];
	const other: string[] = [];
	for (const file of unmerged) {
		if (file.startsWith(prefix)) generated.push(file);
		else other.push(file);
	}
	return { generated, other };
}

export async function executeResolve(
	options: ResolveActionOptions,
	logger: Logger,
): Promise<ResolveResult> {
	const { config, projectRoot } = await loadConfig(options.configPath);
	const paths = getOutputPaths(config, projectRoot);

	logger.header("chowbea resolve");

	if (!isGitRepo(projectRoot)) {
		logger.warn("Not a git repository — nothing to resolve.");
		return {
			isGitRepo: false,
			conflictedGenerated: [],
			conflictedOther: [],
			regenerated: false,
			staged: [],
		};
	}

	const generatedRel = path
		.relative(projectRoot, paths.generated)
		.split(path.sep)
		.join("/");
	const unmerged = listUnmergedFiles(projectRoot);
	const { generated: conflictedGenerated, other: conflictedOther } =
		partitionConflicts(unmerged, generatedRel);

	if (conflictedGenerated.length === 0) {
		if (conflictedOther.length > 0) {
			logger.warn(
				`No generated-file conflicts. ${conflictedOther.length} other conflicted file(s) need manual resolution.`,
			);
		} else {
			logger.done("No generated-file conflicts to resolve.");
		}
		return {
			isGitRepo: true,
			conflictedGenerated: [],
			conflictedOther,
			regenerated: false,
			staged: [],
		};
	}

	logger.step(
		"resolve",
		`Regenerating ${conflictedGenerated.length} conflicted generated file(s) from the spec...`,
	);

	// Regenerate `_generated/` from the cached/local spec — the only correct
	// resolution for a projection of the spec. Overwrites the conflict markers.
	await executeGenerate(
		{
			configPath: options.configPath,
			dryRun: false,
			typesOnly: false,
			operationsOnly: false,
		},
		logger,
	);

	// Stage the regenerated output, clearing the unmerged state.
	stageFiles(projectRoot, [generatedRel]);

	if (conflictedOther.length > 0) {
		logger.warn(
			`Generated files resolved. ${conflictedOther.length} other conflicted file(s) still need manual resolution:`,
		);
		for (const file of conflictedOther) logger.info(`  ${file}`);
	} else {
		logger.done("Generated-file conflicts resolved and staged.");
	}

	return {
		isGitRepo: true,
		conflictedGenerated,
		conflictedOther,
		regenerated: true,
		staged: [generatedRel],
	};
}
