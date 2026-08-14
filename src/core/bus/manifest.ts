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
