import { type FileEnt, NO_CACHE, type R2Bucket } from "./env.ts";

export const ILL_STATE_KEY = "_sync/ills.json";
export const INFO_STATE_KEY = "_sync/info.json";

export type RunSummary = {
	copied: number;
	skipped: number;
	failed: number;
	remaining: number;
	ms: number;
	commit?: string;
	/** Last copy error of the run */
	error?: string;
};

/**
 * Shared by both state files. `queue` is the work list; `_sync/*.json` also carries its length as
 * `pending`, which webui and the bot read as a number (0 means ready)
 */
export type QueueState = {
	target?: string;
	manifest: Record<string, string>;
	queue: FileEnt[];
	live: string[];
	/** Fingerprint of the dirs/files config the listing was made for; a change forces a relist */
	config?: string;
	listFailures?: number;
	/** GitHub listing backoff after errors */
	nextListAt?: string;
	updatedAt?: string;
	/** First error of the last run; a run held back by `nextListAt` keeps the error that set it */
	lastError?: string;
	lastRun?: RunSummary;
};

export type IllState = QueueState & {
	/** Last phi-plugin-ill commit fully mirrored */
	commit?: string;
	/** Tree sha of each synced dir at `target`, so dirs that did not change are not listed again */
	trees?: Record<string, string>;
};

export type InfoState = QueueState & {
	/** Last phi-plugin commit whose mirrored files changed. Consumers reload when this or levelsSha moves */
	commit?: string;
	/** Last phi-plugin commit fully checked, changed or not */
	head?: string;
	/** Commit the html listing in `live` was made for; behind `target` while that REST listing fails */
	htmlCommit?: string;
	/** An info file changed while draining `target` */
	changed?: boolean;
	phigros?: string;
	phigrosVerNum?: number;
	/** Hash of the R2 etags of phi-unpackd's info files (info.csv, notesInfo.json, tips.txt, avatar.txt) */
	levelsSha?: string;
	levelsSongs?: number;
	levelsMax?: number;
	levelsError?: string;
	tagTreeSha?: string;
	tagTreeError?: string;
	aliasesSha?: string;
	aliasesEtag?: string;
	aliasesSongs?: number;
	aliasesCount?: number;
	aliasesError?: string;
	aliasesCheckedAt?: string;
};

export type Loaded<T> = { state: T; baseline?: string };

type Raw = Record<string, unknown>;

const HEARTBEAT = ["updatedAt", "lastRun", "aliasesCheckedAt"];
const LIST_RETRY_MS = 15 * 60_000;
const LIST_RETRY_MAX_MS = 6 * 60 * 60_000;
const CRON_SLACK_MS = 60_000;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isRecord(value: unknown): value is Raw {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function fileEnts(value: unknown, keep: (path: string) => boolean): FileEnt[] {
	if (!Array.isArray(value)) return [];
	const out: FileEnt[] = [];
	for (const ent of value) {
		if (
			!isRecord(ent) ||
			typeof ent.path !== "string" ||
			typeof ent.sha !== "string"
		)
			continue;
		if (!keep(ent.path)) continue;
		out.push({ path: ent.path, sha: ent.sha, size: num(ent.size) ?? 0 });
	}
	return out;
}

function stringMap(
	value: unknown,
	keep: (key: string) => boolean,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isRecord(value)) return out;
	for (const [key, sha] of Object.entries(value)) {
		if (typeof sha === "string" && keep(key)) out[key] = sha;
	}
	return out;
}

function runSummary(value: unknown): RunSummary | undefined {
	if (!isRecord(value)) return undefined;
	return {
		copied: num(value.copied) ?? 0,
		skipped: num(value.skipped) ?? 0,
		failed: num(value.failed) ?? 0,
		remaining: num(value.remaining) ?? 0,
		ms: num(value.ms) ?? 0,
		commit: str(value.commit),
		error: str(value.error),
	};
}

function queueState(raw: Raw, keep: (path: string) => boolean): QueueState {
	const queue = Array.isArray(raw.queue) ? raw.queue : raw.pending;
	return {
		target: str(raw.target),
		manifest: stringMap(raw.manifest, keep),
		queue: fileEnts(queue, keep),
		live: Array.isArray(raw.live)
			? raw.live.filter((p): p is string => typeof p === "string" && keep(p))
			: [],
		config: str(raw.config),
		listFailures: num(raw.listFailures),
		nextListAt: str(raw.nextListAt),
		updatedAt: str(raw.updatedAt),
		lastError: str(raw.lastError),
		lastRun: runSummary(raw.lastRun),
	};
}

export function parseIllState(
	raw: unknown,
	keep: (path: string) => boolean,
	dirs: string[],
): IllState {
	if (!isRecord(raw)) return { manifest: {}, queue: [], live: [] };
	return {
		...queueState(raw, keep),
		commit: str(raw.commit),
		trees: isRecord(raw.trees)
			? stringMap(raw.trees, (dir) => dirs.includes(dir))
			: undefined,
	};
}

export function parseInfoState(
	raw: unknown,
	keep: (path: string) => boolean,
): InfoState {
	if (!isRecord(raw)) return { manifest: {}, queue: [], live: [] };
	return {
		...queueState(raw, keep),
		commit: str(raw.commit),
		head: str(raw.head),
		htmlCommit: str(raw.htmlCommit),
		changed: raw.changed === true ? true : undefined,
		phigros: str(raw.phigros),
		phigrosVerNum: num(raw.phigrosVerNum),
		levelsSha: str(raw.levelsSha),
		levelsSongs: num(raw.levelsSongs),
		levelsMax: num(raw.levelsMax),
		levelsError: str(raw.levelsError),
		tagTreeSha: str(raw.tagTreeSha),
		tagTreeError: str(raw.tagTreeError),
		aliasesSha: str(raw.aliasesSha),
		aliasesEtag: str(raw.aliasesEtag),
		aliasesSongs: num(raw.aliasesSongs),
		aliasesCount: num(raw.aliasesCount),
		aliasesError: str(raw.aliasesError),
		aliasesCheckedAt: str(raw.aliasesCheckedAt),
	};
}

function queueBody(s: QueueState) {
	return {
		target: s.target,
		config: s.config,
		listFailures: s.listFailures,
		nextListAt: s.nextListAt,
		updatedAt: s.updatedAt,
		lastError: s.lastError,
		lastRun: s.lastRun,
		manifest: s.manifest,
		live: s.live,
		queue: s.queue,
	};
}

export function illStateBody(s: IllState): Raw {
	return {
		commit: s.commit,
		pending: s.queue.length,
		trees: s.trees,
		...queueBody(s),
	};
}

export function infoStateBody(s: InfoState): Raw {
	return {
		commit: s.commit,
		pending: s.queue.length,
		head: s.head,
		phigros: s.phigros,
		phigrosVerNum: s.phigrosVerNum,
		levelsSha: s.levelsSha,
		levelsSongs: s.levelsSongs,
		levelsMax: s.levelsMax,
		levelsError: s.levelsError,
		tagTreeSha: s.tagTreeSha,
		tagTreeError: s.tagTreeError,
		aliasesSha: s.aliasesSha,
		aliasesEtag: s.aliasesEtag,
		aliasesSongs: s.aliasesSongs,
		aliasesCount: s.aliasesCount,
		aliasesError: s.aliasesError,
		aliasesCheckedAt: s.aliasesCheckedAt,
		htmlCommit: s.htmlCommit,
		changed: s.changed,
		...queueBody(s),
	};
}

/** The stored JSON minus fields that move on every run, so an idle run does not rewrite the object (P9) */
export function stableKey(body: Raw): string {
	const copy = { ...body };
	for (const key of HEARTBEAT) delete copy[key];
	return JSON.stringify(copy);
}

export async function loadRaw(
	bucket: R2Bucket,
	key: string,
): Promise<{ raw?: Raw; baseline?: string }> {
	const obj = await bucket.get(key);
	if (!obj) return {};
	try {
		const raw = JSON.parse(await obj.text()) as unknown;
		if (!isRecord(raw)) return {};
		return { raw, baseline: stableKey(raw) };
	} catch {
		return {};
	}
}

/** PUT the state only when something other than the heartbeat fields changed; returns whether it wrote */
export async function saveIfChanged(
	bucket: R2Bucket,
	key: string,
	state: { updatedAt?: string },
	body: () => Raw,
	baseline: string | undefined,
	now = new Date(),
): Promise<boolean> {
	if (baseline !== undefined && stableKey(body()) === baseline) return false;
	state.updatedAt = now.toISOString();
	await bucket.put(key, JSON.stringify(body()), {
		httpMetadata: { contentType: "application/json", cacheControl: NO_CACHE },
	});
	return true;
}

export function listBlocked(s: QueueState, now: number): boolean {
	const at = s.nextListAt ? Date.parse(s.nextListAt) : Number.NaN;
	return Number.isFinite(at) && now < at;
}

/** 15 min, 30 min, 1 h, … capped at 6 h */
export function listFailed(s: QueueState, now: number): void {
	const failures = (s.listFailures ?? 0) + 1;
	const wait = Math.min(LIST_RETRY_MAX_MS, LIST_RETRY_MS * 2 ** (failures - 1));
	s.listFailures = failures;
	s.nextListAt = new Date(now + wait - CRON_SLACK_MS).toISOString();
}

export function listOk(s: QueueState): void {
	s.listFailures = undefined;
	s.nextListAt = undefined;
}

export function publicIllState(s: IllState) {
	return {
		commit: s.commit,
		pending: s.queue.length,
		files: Object.keys(s.manifest).length,
		nextListAt: s.nextListAt,
		updatedAt: s.updatedAt,
		lastError: s.lastError,
		lastRun: s.lastRun,
	};
}

export function publicInfoState(s: InfoState) {
	return {
		commit: s.commit,
		pending: s.queue.length,
		files: Object.keys(s.manifest).length,
		head: s.head,
		phigros: s.phigros,
		phigrosVerNum: s.phigrosVerNum,
		levelsSha: s.levelsSha,
		levelsSongs: s.levelsSongs,
		levelsMax: s.levelsMax,
		levelsError: s.levelsError,
		tagTreeSha: s.tagTreeSha,
		tagTreeError: s.tagTreeError,
		aliasesSha: s.aliasesSha,
		aliasesEtag: s.aliasesEtag,
		aliasesSongs: s.aliasesSongs,
		aliasesCount: s.aliasesCount,
		aliasesError: s.aliasesError,
		aliasesCheckedAt: s.aliasesCheckedAt,
		nextListAt: s.nextListAt,
		updatedAt: s.updatedAt,
		lastError: s.lastError,
		lastRun: s.lastRun,
	};
}
