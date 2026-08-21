/**
 * `doctor` action — detect (and optionally repair) generated artifacts that
 * are wrongly tracked in git.
 *
 * The `_internal/` folder (cached spec + `.api-cache.json`, whose timestamp
 * and hash change on every fetch) is machine state that must never be
 * committed. `init` gitignores it, but projects created before that feature —
 * or that never ran `init` — commit it and then fight constant, meaningless
 * merge conflicts. `doctor` reports those tracked artifacts and, with `--fix`,
 * untracks them (`git rm --cached`, keeping the files on disk) and ensures the
 * ignore rule is present.
 */

import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { getOutputPaths, loadConfig } from "../config.js";
import {
	isGitRepo,
	listTrackedFiles,
	removeFromIndex,
	stageFiles,
} from "../git.js";
import { ensureGitignoreEntry, isGitignored } from "./env-manager.js";

const INTERNAL_IGNORE_ENTRY = "_internal/";
const INTERNAL_IGNORE_COMMENT =
	"# chowbea cache (timestamps, downloaded specs)";

export interface DoctorActionOptions {
	configPath?: string;
	/** Apply repairs (untrack + gitignore). Defaults to report-only. */
	fix?: boolean;
}

export interface DoctorResult {
	isGitRepo: boolean;
	/** Repo-relative paths under `_internal/` that are currently tracked. */
	trackedArtifacts: string[];
	/** Whether `.gitignore` already ignores `_internal/`. */
	hasIgnoreRule: boolean;
	/** Whether `--fix` changed anything. */
	fixApplied: boolean;
	/** Paths untracked by `--fix`. */
	untracked: string[];
	/** Whether `--fix` added the ignore rule. */
	ignoreRuleAdded: boolean;
	/** True when there was nothing to repair. */
	healthy: boolean;
}

export async function executeDoctor(
	options: DoctorActionOptions,
	logger: Logger,
): Promise<DoctorResult> {
	const fix = options.fix ?? false;
	const { config, projectRoot } = await loadConfig(options.configPath);
	const paths = getOutputPaths(config, projectRoot);

	logger.header("chowbea doctor");

	if (!isGitRepo(projectRoot)) {
		logger.warn("Not a git repository — nothing to check.");
		return {
			isGitRepo: false,
			trackedArtifacts: [],
			hasIgnoreRule: false,
			fixApplied: false,
			untracked: [],
			ignoreRuleAdded: false,
			healthy: true,
		};
	}

	const internalRel = path
		.relative(projectRoot, paths.internal)
		.split(path.sep)
		.join("/");
	const trackedArtifacts = listTrackedFiles(projectRoot, internalRel);
	const hasIgnoreRule = await isGitignored(projectRoot, INTERNAL_IGNORE_ENTRY);

	if (trackedArtifacts.length === 0 && hasIgnoreRule) {
		logger.done(
			"No tracked cache artifacts — generated output is conflict-safe.",
		);
		return {
			isGitRepo: true,
			trackedArtifacts,
			hasIgnoreRule,
			fixApplied: false,
			untracked: [],
			ignoreRuleAdded: false,
			healthy: true,
		};
	}

	if (trackedArtifacts.length > 0) {
		logger.warn(
			`${trackedArtifacts.length} cache artifact(s) under ${internalRel}/ are tracked in git — they churn on every regen and trigger merge conflicts.`,
		);
		for (const file of trackedArtifacts) {
			logger.info(`  tracked: ${file}`);
		}
	}
	if (!hasIgnoreRule) {
		logger.warn(
			`No '${INTERNAL_IGNORE_ENTRY}' rule in .gitignore — the cache may get re-committed.`,
		);
	}

	if (!fix) {
		logger.info(
			"Run 'chowbea doctor --fix' to untrack the cache and ignore it.",
		);
		return {
			isGitRepo: true,
			trackedArtifacts,
			hasIgnoreRule,
			fixApplied: false,
			untracked: [],
			ignoreRuleAdded: false,
			healthy: false,
		};
	}

	let ignoreRuleAdded = false;
	if (!hasIgnoreRule) {
		ignoreRuleAdded = await ensureGitignoreEntry(
			projectRoot,
			INTERNAL_IGNORE_ENTRY,
			INTERNAL_IGNORE_COMMENT,
		);
		if (ignoreRuleAdded) {
			logger.step("gitignore", `Added ${INTERNAL_IGNORE_ENTRY} to .gitignore`);
		}
	}

	let untracked: string[] = [];
	if (trackedArtifacts.length > 0) {
		removeFromIndex(projectRoot, [internalRel]);
		untracked = trackedArtifacts;
		logger.step("git", `Untracked ${internalRel}/ (files kept on disk)`);
		if (ignoreRuleAdded) {
			stageFiles(projectRoot, [".gitignore"]);
		}
	}

	logger.done("Repaired. Commit the staged changes to finish.");

	return {
		isGitRepo: true,
		trackedArtifacts,
		hasIgnoreRule,
		fixApplied: true,
		untracked,
		ignoreRuleAdded,
		healthy: false,
	};
}
