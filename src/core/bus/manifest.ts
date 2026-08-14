import { createHash } from "node:crypto";

/** Manifest format version. Bump only with a migration story (spec §3). */
export const BUS_VERSION = "1";

export type BusTypeKind = "type" | "interface" | "enum";

export interface BusTypeEntry {
	name: string;
	kind: BusTypeKind;
	declaration: string;
	/** Repo-relative source path, posix separators. */
	source: string;
	/** 1-based line of the declaration in `source`. */
	line: number;
	/** hashText(declaration) — drives incremental emission. */
	hash: string;
}

export interface BusManifest {
	chowbeaBus: string;
	generatedAt: string;
	hash: string;
	barrels: Record<string, BusTypeEntry[]>;
}

export class BusVersionError extends Error {
	constructor(found: string) {
		super(
			`Unsupported chowbea bus manifest version "${found}" (this CLI supports "${BUS_VERSION}"). ` +
				`Upgrade chowbea-axios.`,
		);
		this.name = "BusVersionError";
	}
}

export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable across key order: hash a sorted, canonical projection of the barrels. */
export function hashBarrels(barrels: BusManifest["barrels"]): string {
	const canonical = Object.keys(barrels)
		.sort()
		.map((key) => [key, barrels[key].map((e) => [e.name, e.kind, e.declaration, e.source, e.line])]);
	return hashText(JSON.stringify(canonical));
}

export function buildManifest(barrels: BusManifest["barrels"], now: Date): BusManifest {
	return {
		chowbeaBus: BUS_VERSION,
		generatedAt: now.toISOString(),
		hash: hashBarrels(barrels),
		barrels,
	};
}

const VALID_KINDS = new Set<BusTypeKind>(["type", "interface", "enum"]);

/**
 * Rejects barrel keys that could escape `busDir` when joined into a path
 * (`path.join(busDir, name)` in emit.ts — a `\` or `..` segment traverses
 * out of it, notably on Windows where `\` is a separator) or that are
 * otherwise unusable as a relative path segment.
 */
function isSafeBarrelKey(key: string): boolean {
	if (key.length === 0 || key.includes("\\")) return false;
	const segments = key.split("/");
	return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** A network-fetched manifest is untrusted input — validate every entry field before it's trusted. */
function assertValidEntry(entry: unknown, key: string, index: number): asserts entry is BusTypeEntry {
	const label = `barrels["${key}"][${index}]`;
	if (typeof entry !== "object" || entry === null) {
		throw new Error(`Malformed chowbea bus manifest: ${label} is not an object`);
	}
	const e = entry as Record<string, unknown>;
	for (const field of ["name", "declaration", "source", "hash"] as const) {
		if (typeof e[field] !== "string") {
			throw new Error(`Malformed chowbea bus manifest: ${label}.${field} must be a string`);
		}
	}
	if (typeof e.kind !== "string" || !VALID_KINDS.has(e.kind as BusTypeKind)) {
		throw new Error(`Malformed chowbea bus manifest: ${label}.kind must be one of "type" | "interface" | "enum"`);
	}
	if (typeof e.line !== "number") {
		throw new Error(`Malformed chowbea bus manifest: ${label}.line must be a number`);
	}
}

/**
 * Parses a manifest and validates it structurally — this is the trust
 * boundary every network-fetched manifest passes through (a hostile or
 * compromised bus endpoint is untrusted input). Beyond the envelope
 * (version/hash/barrels), each barrel key must be a safe relative path
 * segment (emit.ts does `path.join(busDir, name)` — an unchecked key
 * could traverse out of `busDir`) and each entry's fields must have the
 * expected types (a non-string `declaration`, for example, would
 * otherwise emit a literal `undefined` into generated code).
 */
export function parseManifest(json: string): BusManifest {
	const raw = JSON.parse(json) as Partial<BusManifest>;
	if (typeof raw !== "object" || raw === null || typeof raw.chowbeaBus !== "string") {
		throw new Error("Malformed chowbea bus manifest: missing chowbeaBus version field");
	}
	if (raw.chowbeaBus !== BUS_VERSION) {
		throw new BusVersionError(raw.chowbeaBus);
	}
	if (typeof raw.hash !== "string" || typeof raw.barrels !== "object" || raw.barrels === null) {
		throw new Error("Malformed chowbea bus manifest: missing hash or barrels");
	}
	for (const [key, entries] of Object.entries(raw.barrels)) {
		if (!isSafeBarrelKey(key)) {
			throw new Error(`Malformed chowbea bus manifest: unsafe barrel key "${key}"`);
		}
		if (!Array.isArray(entries)) {
			throw new Error(`Malformed chowbea bus manifest: barrels["${key}"] is not an array`);
		}
		entries.forEach((entry, i) => assertValidEntry(entry, key, i));
	}
	return raw as BusManifest;
}

export interface BusDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

/** Compare by type name (names are globally unique — duplicates are extraction errors). */
export function diffManifests(base: BusManifest, next: BusManifest): BusDiff {
	const flat = (m: BusManifest) =>
		new Map(Object.values(m.barrels).flat().map((e) => [e.name, e.hash]));
	const a = flat(base);
	const b = flat(next);
	return {
		added: [...b.keys()].filter((n) => !a.has(n)).sort(),
		removed: [...a.keys()].filter((n) => !b.has(n)).sort(),
		changed: [...b.keys()].filter((n) => a.has(n) && a.get(n) !== b.get(n)).sort(),
	};
}
