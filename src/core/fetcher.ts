/**
 * OpenAPI spec fetcher with retry logic and caching.
 * Supports graceful fallback to cached spec on network failures.
 */

import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import type { FetchAuthConfig } from "./config.js";
import { NetworkError, SpecNotFoundError } from "./errors.js";
import type { Logger } from "../adapters/logger-interface.js";

/**
 * Parses an OpenAPI spec from raw text. Accepts both JSON and YAML.
 *
 * Strategy:
 * - If `sourceHint` ends in `.yaml` / `.yml`, parse as YAML directly.
 * - Otherwise try JSON first (the most common case and the format of the
 *   cache file), then fall back to YAML on parse failure.
 *
 * Throws an `Error` with a clear message if neither parser accepts the
 * content. Issue #23.
 */
export function parseSpecContent(content: string, sourceHint?: string): unknown {
	const isYamlExt = sourceHint != null && /\.ya?ml$/i.test(sourceHint);

	if (isYamlExt) {
		try {
			return parseYaml(content);
		} catch (err) {
			throw new Error(
				`Failed to parse YAML spec${sourceHint ? ` at ${sourceHint}` : ""}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	// Default: JSON first (cache files and most public endpoints), YAML
	// fallback (private specs hand-authored in YAML).
	try {
		return JSON.parse(content);
	} catch (jsonErr) {
		try {
			return parseYaml(content);
		} catch (yamlErr) {
			throw new Error(
				`Failed to parse spec${sourceHint ? ` at ${sourceHint}` : ""} as JSON or YAML. ` +
					`JSON error: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}. ` +
					`YAML error: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}.`,
			);
		}
	}
}

/**
 * Normalizes a spec buffer to a JSON-encoded form. Parses with auto-
 * detection (JSON or YAML), then re-encodes as canonical JSON.
 *
 * The downstream pipeline (cache file, generator, diff, validate) all
 * expect JSON, so we convert at the parse boundary. The `spec` object is
 * also returned so callers don't need to re-parse.
 *
 * Issue #23.
 */
export function normalizeSpecBuffer(buffer: Buffer, sourceHint?: string): {
	spec: unknown;
	jsonBuffer: Buffer;
} {
	const content = buffer.toString("utf8");
	const spec = parseSpecContent(content, sourceHint);
	const jsonBuffer = Buffer.from(JSON.stringify(spec, null, 2), "utf8");
	return { spec, jsonBuffer };
}

/**
 * Cache metadata stored in .api-cache.json
 */
export interface CacheMetadata {
	/** SHA256 hash of the OpenAPI spec content */
	hash: string;
	/** Timestamp when the spec was last fetched */
	timestamp: number;
	/** The endpoint URL used to fetch the spec */
	endpoint: string;
}

/**
 * Result of fetching the OpenAPI spec.
 */
export interface FetchResult {
	/** The raw spec content as a Buffer */
	buffer: Buffer;
	/** SHA256 hash of the content */
	hash: string;
	/** Whether the spec has changed since last fetch */
	hasChanged: boolean;
	/** Whether this was loaded from cache due to network failure */
	fromCache: boolean;
}

/**
 * Retry configuration for network operations.
 */
export interface RetryConfig {
	/** Maximum number of retry attempts (default: 3) */
	maxAttempts: number;
	/** Base delay between retries in ms (default: 1000) */
	baseDelay: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	baseDelay: 1000,
	backoffMultiplier: 2,
};

/**
 * Interpolates environment variables in a string.
 *
 * Recognizes both `$VAR_NAME` and `${VAR_NAME}` forms. Mismatched braces
 * (`${VAR` or `$VAR}`) no longer match — the prior regex used independent
 * `?`-quantified braces and silently consumed half-pairs. Issue #29.
 *
 * Throws if a referenced env var is not set.
 */
export function interpolateEnvVars(value: string): string {
	// Match either `${VAR}` (braced) or `$VAR` (bare). Two alternatives
	// rather than independent optional braces ensures we never consume a
	// stray `{` or `}`.
	return value.replace(
		/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gi,
		(_match, braced: string | undefined, bare: string | undefined) => {
			const varName = braced ?? bare ?? "";
			const envValue = process.env[varName];
			if (envValue === undefined) {
				throw new Error(
					`Environment variable ${varName} is not set (referenced in: ${value})`
				);
			}
			return envValue;
		},
	);
}

/**
 * Interpolates environment variables in all header values.
 */
export function interpolateHeaders(
	headers: Record<string, string>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key] = interpolateEnvVars(value);
	}
	return result;
}

/**
 * Builds a `Basic <base64>` Authorization header value from already-resolved
 * (interpolated) Basic Auth credentials. Shared by spec fetching and Type
 * Bus fetching so both apply auth the same way.
 */
export function buildBasicAuthHeader(auth: { username: string; password: string }): string {
	const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
	return `Basic ${credentials}`;
}

/**
 * Resolves `[fetch.auth]` Basic Auth credentials from their configured env
 * vars, non-interactively — no prompting. Throws if either credential can't
 * be resolved. For contexts that must never block on a TTY prompt (Type Bus
 * sync from `fetch`/`watch`); the interactive spec-fetch path has its own
 * prompt-capable resolver.
 */
export function resolveBasicAuthNonInteractive(
	auth: FetchAuthConfig
): { username: string; password: string } {
	let username: string | undefined;
	let password: string | undefined;
	if (auth.username) {
		try {
			username = interpolateEnvVars(auth.username);
		} catch {
			// reported via the throw below
		}
	}
	if (auth.password) {
		try {
			password = interpolateEnvVars(auth.password);
		} catch {
			// reported via the throw below
		}
	}
	if (!username || !password) {
		throw new Error(
			"Basic Auth credentials are incomplete. " +
				"Set the environment variables referenced in [fetch.auth] " +
				"(e.g. SWAGGER_USER, SWAGGER_PASS)."
		);
	}
	return { username, password };
}

/**
 * Computes SHA256 hash of a buffer.
 */
export function computeHash(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Delays execution for the specified milliseconds.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Loads cache metadata from the cache file.
 * Returns null if cache doesn't exist or is corrupted.
 */
export async function loadCacheMetadata(
	cachePath: string
): Promise<CacheMetadata | null> {
	try {
		await access(cachePath);
		const content = await readFile(cachePath, "utf8");
		const parsed = JSON.parse(content) as CacheMetadata;

		// Validate cache structure
		if (
			typeof parsed.hash === "string" &&
			typeof parsed.timestamp === "number" &&
			typeof parsed.endpoint === "string"
		) {
			return parsed;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Saves cache metadata to the cache file.
 */
export async function saveCacheMetadata(
	cachePath: string,
	metadata: CacheMetadata
): Promise<void> {
	await writeFile(cachePath, JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * Loads the cached OpenAPI spec from disk.
 * Returns null if spec doesn't exist.
 */
export async function loadCachedSpec(specPath: string): Promise<Buffer | null> {
	try {
		await access(specPath);
		return await readFile(specPath);
	} catch {
		return null;
	}
}

/**
 * Validates a remote endpoint URL before we issue an HTTP request to it.
 *
 * - Must parse as a URL (rejects garbage strings).
 * - Must use `http:` or `https:` (rejects `file:`, `data:`, custom
 *   schemes that could exfiltrate or sidestep the fetch pipeline).
 *
 * Issue #20. Tightening to also reject private/loopback hosts is a
 * separate optional layer — left to a future opt-in flag because most
 * legitimate users develop against `localhost:3000`.
 */
function validateEndpointUrl(endpoint: string): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new NetworkError(
			endpoint,
			`Invalid endpoint URL: ${endpoint}`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new NetworkError(
			endpoint,
			`Unsupported URL scheme "${url.protocol}" — only http: and https: are allowed for remote spec endpoints.`,
		);
	}
	return url;
}

/**
 * Fetches the OpenAPI spec from a remote endpoint with retry logic.
 * Falls back to cached spec on network failure.
 */
export async function fetchOpenApiSpec(options: {
	endpoint: string;
	specPath: string;
	cachePath: string;
	logger: Logger;
	force?: boolean;
	retryConfig?: RetryConfig;
	headers?: Record<string, string>;
	auth?: { username: string; password: string };
}): Promise<FetchResult> {
	const { endpoint, specPath, cachePath, logger, force = false } = options;
	const retryConfig = options.retryConfig ?? DEFAULT_RETRY_CONFIG;

	// Reject malformed or non-http(s) URLs before issuing any network
	// request. Issue #20.
	validateEndpointUrl(endpoint);

	// Interpolate env vars in headers
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (options.headers) {
		try {
			const interpolated = interpolateHeaders(options.headers);
			Object.assign(headers, interpolated);
		} catch (error) {
			throw new Error(
				`Failed to interpolate headers: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	// Apply Basic Auth if provided (takes precedence over any Authorization header)
	if (options.auth) {
		// Remove any existing Authorization header (case-insensitive) to avoid duplicates
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === "authorization") {
				delete headers[key];
			}
		}
		headers["Authorization"] = buildBasicAuthHeader(options.auth);
	}

	// Load existing cache metadata
	const existingCache = await loadCacheMetadata(cachePath);

	// Attempt to fetch with retries
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
		try {
			logger.debug({ attempt, endpoint }, "Fetching OpenAPI spec...");

			const response = await fetch(endpoint, {
				headers,
			});

			if (!response.ok) {
				throw new NetworkError(
					endpoint,
					`HTTP ${response.status}: ${response.statusText}`,
					response.status
				);
			}

			const arrayBuffer = await response.arrayBuffer();
			const rawBuffer = Buffer.from(arrayBuffer);

			// Normalize to JSON so the cache file and downstream parsers
			// always see JSON, even when the endpoint serves YAML. Issue #23.
			// We pass the endpoint as a hint so YAML extensions are picked up
			// directly; for unknown content-types we fall back to JSON-then-YAML.
			const { jsonBuffer } = normalizeSpecBuffer(rawBuffer, endpoint);
			const hash = computeHash(jsonBuffer);

			// Check if content has changed
			const hasChanged = force || !existingCache || existingCache.hash !== hash;

			logger.debug(
				{ hash, hasChanged, bytes: jsonBuffer.length },
				"Spec fetched successfully"
			);

			return {
				buffer: jsonBuffer,
				hash,
				hasChanged,
				fromCache: false,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < retryConfig.maxAttempts) {
				const delayMs =
					retryConfig.baseDelay *
					retryConfig.backoffMultiplier ** (attempt - 1);

				logger.warn(
					{
						attempt,
						maxAttempts: retryConfig.maxAttempts,
						delayMs,
						error: lastError.message,
					},
					"Fetch failed, retrying..."
				);

				await delay(delayMs);
			}
		}
	}

	// All retries failed - try to fall back to cached spec
	logger.warn(
		{ attempts: retryConfig.maxAttempts, error: lastError?.message },
		"All fetch attempts failed, checking for cached spec..."
	);

	const cachedSpec = await loadCachedSpec(specPath);

	if (cachedSpec && existingCache) {
		logger.info("Using cached OpenAPI spec due to network failure");

		return {
			buffer: cachedSpec,
			hash: existingCache.hash,
			hasChanged: false, // Don't regenerate if using cached
			fromCache: true,
		};
	}

	// No cache available - throw the network error
	throw new NetworkError(
		endpoint,
		`Failed to fetch OpenAPI spec after ${retryConfig.maxAttempts} attempts: ${lastError?.message}`
	);
}

/**
 * Saves the fetched spec and updates cache metadata.
 */
export async function saveSpec(options: {
	buffer: Buffer;
	hash: string;
	endpoint: string;
	specPath: string;
	cachePath: string;
}): Promise<void> {
	const { buffer, hash, endpoint, specPath, cachePath } = options;

	// Write spec file
	await writeFile(specPath, buffer);

	// Update cache metadata
	await saveCacheMetadata(cachePath, {
		hash,
		timestamp: Date.now(),
		endpoint,
	});
}

/**
 * Checks if the local spec exists and is parseable as JSON or YAML.
 * Issue #23 (was JSON-only).
 */
export async function hasLocalSpec(specPath: string): Promise<boolean> {
	try {
		await access(specPath);
		const content = await readFile(specPath, "utf8");
		parseSpecContent(content, specPath); // throws on invalid
		return true;
	} catch {
		return false;
	}
}

/**
 * Loads and parses the local OpenAPI spec. Accepts both JSON and YAML
 * (auto-detected via file extension, with JSON-then-YAML fallback for
 * unknown extensions).
 *
 * Returns a `buffer` that's always JSON-encoded — even when the source
 * was YAML — so the rest of the pipeline (cache file, generator) can
 * keep using `JSON.parse` without change. Hashing of this normalized
 * buffer also gives stable cache keys regardless of YAML whitespace
 * variations. Issue #23.
 *
 * Throws `SpecNotFoundError` if the file doesn't exist, or a generic
 * `Error` if neither JSON nor YAML can parse the content.
 */
export async function loadLocalSpec(specPath: string): Promise<{
	spec: unknown;
	buffer: Buffer;
}> {
	try {
		await access(specPath);
	} catch {
		throw new SpecNotFoundError(specPath);
	}

	const rawBuffer = await readFile(specPath);
	const { spec, jsonBuffer } = normalizeSpecBuffer(rawBuffer, specPath);
	return { spec, buffer: jsonBuffer };
}

/**
 * Loads a spec from a local file and copies it to the cache location.
 * Returns a FetchResult-like object for consistency with remote fetching.
 */
export async function loadLocalSpecFile(options: {
	localPath: string;
	specPath: string;
	cachePath: string;
	logger: Logger;
	force?: boolean;
}): Promise<FetchResult> {
	const { localPath, cachePath, logger, force = false } = options;

	logger.info({ localPath }, "Loading local spec file...");

	// Load existing cache metadata
	const existingCache = await loadCacheMetadata(cachePath);

	// Load and parse the local file
	const { buffer } = await loadLocalSpec(localPath);
	const hash = computeHash(buffer);

	// Check if content has changed
	const hasChanged = force || !existingCache || existingCache.hash !== hash;

	logger.debug({ hash, hasChanged, bytes: buffer.length }, "Local spec loaded");

	return {
		buffer,
		hash,
		hasChanged,
		fromCache: false,
	};
}
