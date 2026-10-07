import { DEFAULT_ALIAS_EXPORT_URL, syncAliases } from "./alias-sync.ts";
import {
	type Env,
	errText,
	type FileEnt,
	IMAGE_CACHE,
	NO_CACHE,
	type R2Bucket,
	sha256Hex,
} from "./env.ts";
import {
	fetchRaw,
	headCommit,
	listContents,
	listRootTrees,
	listSubtree,
	RawError,
	readPhigrosVersion,
} from "./github.ts";
import { summarizeInfoCsv } from "./info-file.ts";
import {
	ILL_STATE_KEY,
	type IllState,
	INFO_STATE_KEY,
	type InfoState,
	illStateBody,
	infoStateBody,
	type Loaded,
	listBlocked,
	listFailed,
	listOk,
	loadRaw,
	parseIllState,
	parseInfoState,
	type QueueState,
	type RunSummary,
	saveIfChanged,
} from "./state.ts";

const TIME_BUDGET_MS = 25_000;
const CONCURRENCY = 6;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DEFAULT_TAGTREE_URL = "https://phib19.top:8080/chartsTag/get/tagTree";
const DEFAULT_INFO_FILES = [
	"chaplist.yaml",
	"infolist.json",
	"nicklist.yaml",
	"spinfo.json",
];
const DEFAULT_HTML_DIRS: string[] = [];
const DEFAULT_HTML_FILES = [
	"otherimg/0.png",
	"otherimg/1.png",
	"otherimg/2.png",
	"otherimg/3.png",
	"otherimg/4.png",
	"otherimg/5.png",
	"otherimg/A.png",
	"otherimg/B.png",
	"otherimg/C.png",
	"otherimg/F.png",
	"otherimg/FC.png",
	"otherimg/NEW.png",
	"otherimg/S.png",
	"otherimg/V.png",
	"otherimg/phi.png",
	"otherimg/phigros.png",
	"otherimg/data.png",
	"otherimg/Star1.png",
	"otherimg/Star2.png",
];

export const APK_INFO_FILES = [
	"info.csv",
	"notesInfo.json",
	"tips.txt",
	"avatar.txt",
];
const APK_ILL_DIRS = ["ill", "illLow", "illBlur"];
const APK_HTML_DIRS = ["avatar"];

const PROTECTED_PREFIXES = [
	"original_ill/ill/",
	"original_ill/illLow/",
	"original_ill/illBlur/",
	"html/avatar/",
	"info/",
	"phira/",
	"music/",
	"web-cards/",
	"_sync/",
];

export type SyncOptions = {
	/** Ignore the GitHub error backoff (manual /sync) */
	force?: boolean;
	now?: number;
};

type PutResult = { copied: boolean; sha: string };

function csvList(raw: string | undefined, fallback: string[]): string[] {
	if (raw === undefined) return fallback;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function topDir(path: string): string {
	return path.split("/")[0] || "";
}

function extOf(path: string): string {
	const i = path.lastIndexOf(".");
	return i < 0 ? "" : path.slice(i).toLowerCase();
}

function mimeOf(path: string): string {
	switch (extOf(path)) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".json":
			return "application/json";
		case ".csv":
			return "text/csv";
		case ".yaml":
		case ".yml":
			return "text/yaml";
		case ".txt":
			return "text/plain";
		default:
			return "image/png";
	}
}

function dirsOf(env: Env): string[] {
	return csvList(env.ILL_DIRS, []).filter((dir) => !APK_ILL_DIRS.includes(dir));
}

function r2Key(env: Env, rel: string): string {
	const p = env.ILL_PREFIX.replace(/\/+$/, "");
	return p ? `${p}/${rel}` : rel;
}

function wanted(dirs: Set<string>, path: string): boolean {
	return IMAGE_EXT.has(extOf(path)) && dirs.has(topDir(path));
}

function infoRepo(env: Env): string {
	return env.INFO_REPO?.trim() || "Catrong/phi-plugin";
}

function infoRef(env: Env): string {
	return env.INFO_REF?.trim() || "main";
}

function infoPrefixOf(env: Env): string {
	return (env.INFO_PREFIX || "info").replace(/\/+$/, "");
}

function infoFileNames(env: Env): string[] {
	return csvList(env.INFO_FILES, DEFAULT_INFO_FILES).filter(
		(name) => !APK_INFO_FILES.includes(name),
	);
}

function htmlPrefixOf(env: Env): string {
	return (env.HTML_PREFIX || "html").replace(/\/+$/, "");
}

type HtmlConfig = { dirs: string[]; files: string[] };

function htmlConfig(env: Env): HtmlConfig {
	return {
		dirs: csvList(env.HTML_DIRS, DEFAULT_HTML_DIRS).filter(
			(dir) => !APK_HTML_DIRS.includes(dir),
		),
		files: csvList(env.HTML_FILES, DEFAULT_HTML_FILES).filter(
			(file) => dirOf(file) && !APK_HTML_DIRS.includes(dirOf(file)),
		),
	};
}

function htmlWanted(html: HtmlConfig, path: string): boolean {
	if (!path.startsWith("html/") || !IMAGE_EXT.has(extOf(path))) return false;
	const rel = htmlRel(path);
	return html.dirs.includes(dirOf(rel)) || html.files.includes(rel);
}

function htmlRel(path: string): string {
	return path.slice("html/".length);
}

async function infoConfigKey(env: Env): Promise<string> {
	const html = htmlConfig(env);
	const parts = [
		infoFileNames(env).join(","),
		html.dirs.join(","),
		html.files.join(","),
	];
	return (await sha256Hex(parts.join("\n"))).slice(0, 16);
}

function tagTreeUrl(env: Env): string {
	return env.TAGTREE_URL?.trim() || DEFAULT_TAGTREE_URL;
}

function aliasExportUrl(env: Env): string {
	return env.ALIAS_EXPORT_URL?.trim() || DEFAULT_ALIAS_EXPORT_URL;
}

function idle(state: QueueState, commit: string | undefined): RunSummary {
	return {
		copied: 0,
		skipped: 0,
		failed: 0,
		remaining: state.queue.length,
		ms: 0,
		commit,
	};
}

export async function loadIllState(env: Env): Promise<Loaded<IllState>> {
	const dirs = dirsOf(env);
	const set = new Set(dirs);
	const { raw, baseline } = await loadRaw(env.ILLS, ILL_STATE_KEY);
	return {
		state: parseIllState(raw, (path) => wanted(set, path), dirs),
		baseline,
	};
}

export async function loadInfoState(env: Env): Promise<Loaded<InfoState>> {
	const files = new Set(infoFileNames(env));
	const html = htmlConfig(env);
	const { raw, baseline } = await loadRaw(env.ILLS, INFO_STATE_KEY);
	return {
		state: parseInfoState(
			raw,
			(path) => files.has(path) || htmlWanted(html, path),
		),
		baseline,
	};
}

/** Delete every object under `prefix` (one owned dir) whose relative key is not in `keep` */
export async function dropStale(
	bucket: R2Bucket,
	prefix: string,
	keep: Set<string>,
): Promise<number> {
	if (
		!prefix.endsWith("/") ||
		PROTECTED_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p))
	) {
		throw new Error(`refusing to prune ${prefix}`);
	}
	let cursor: string | undefined;
	const stale: string[] = [];
	for (;;) {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const obj of page.objects) {
			if (!keep.has(obj.key.slice(prefix.length))) stale.push(obj.key);
		}
		if (!page.truncated || !page.cursor) break;
		cursor = page.cursor;
	}
	for (let i = 0; i < stale.length; i += 100) {
		await bucket.delete(stale.slice(i, i + 100));
	}
	return stale.length;
}

/** Copy queued files with a small pool until the queue or the time budget runs out; failures requeue, upstream 404s are dropped */
export async function drain(
	state: QueueState,
	commit: string,
	put: (file: FileEnt) => Promise<PutResult>,
	budgetMs = TIME_BUDGET_MS,
	concurrency = CONCURRENCY,
): Promise<RunSummary> {
	const started = Date.now();
	let copied = 0;
	let skipped = 0;
	let failed = 0;
	let error: string | undefined;
	const todo = state.queue.slice();
	const retry: FileEnt[] = [];

	const worker = async () => {
		while (todo.length && Date.now() - started < budgetMs) {
			const file = todo.shift() as FileEnt;
			try {
				const res = await put(file);
				if (res.copied) copied += 1;
				else skipped += 1;
				state.manifest[file.path] = res.sha;
			} catch (err) {
				failed += 1;
				error = errText(err);
				if (err instanceof RawError && err.status === 404)
					delete state.manifest[file.path];
				else retry.push(file);
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(concurrency, todo.length) }, worker),
	);
	state.queue = [...retry, ...todo];
	return {
		copied,
		skipped,
		failed,
		remaining: state.queue.length,
		ms: Date.now() - started,
		commit,
		error,
	};
}

/** Upload a git blob unless R2 already holds that blob sha */
async function putGitBlob(
	env: Env,
	repo: string,
	commit: string,
	relPath: string,
	key: string,
	sha: string,
): Promise<PutResult> {
	const existing = await env.ILLS.head(key);
	if (existing?.customMetadata?.gitSha === sha) return { copied: false, sha };
	const buf = await fetchRaw(repo, commit, relPath);
	await env.ILLS.put(key, buf, {
		httpMetadata: { contentType: mimeOf(relPath), cacheControl: IMAGE_CACHE },
		customMetadata: { gitSha: sha },
	});
	return { copied: true, sha };
}

/** Info files are queued on every new commit and hashed, so an untouched file uploads nothing and leaves `commit` alone */
async function putInfoFile(
	env: Env,
	commit: string,
	path: string,
	known: string | undefined,
): Promise<PutResult> {
	const buf = await fetchRaw(infoRepo(env), commit, `resources/info/${path}`);
	const sha = await sha256Hex(buf);
	if (known === sha) return { copied: false, sha };
	const key = `${infoPrefixOf(env)}/${path}`;
	const existing = await env.ILLS.head(key);
	if (existing?.customMetadata?.contentSha === sha)
		return { copied: false, sha };
	await env.ILLS.put(key, buf, {
		httpMetadata: { contentType: mimeOf(path), cacheControl: NO_CACHE },
		customMetadata: { contentSha: sha, gitCommit: commit },
	});
	return { copied: true, sha };
}

/** Relist SP/chap dirs whose tree sha changed (P6) when the head commit or the config moved; returns whether any was relisted */
async function refreshIllQueue(
	env: Env,
	state: IllState,
	commit: string,
): Promise<boolean> {
	const dirs = dirsOf(env);
	const config = dirs.join(",");
	const sameConfig = state.config === config;
	if (sameConfig && state.target === commit && state.queue.length) return false;
	if (sameConfig && state.commit === commit && !state.queue.length)
		return false;
	const roots = await listRootTrees(env, commit, dirs);
	const known = sameConfig ? state.trees || {} : {};
	const changed = dirs.filter((dir) => known[dir] !== roots.get(dir));
	const set = new Set(dirs);
	const fresh: FileEnt[] = [];
	for (const dir of changed) {
		const sha = roots.get(dir);
		if (sha)
			fresh.push(
				...(await listSubtree(env, dir, sha)).filter((file) =>
					wanted(set, file.path),
				),
			);
	}
	const relisted = (path: string) => changed.includes(topDir(path));
	const trees: Record<string, string> = {};
	for (const [dir, sha] of roots) trees[dir] = sha;
	state.target = commit;
	state.config = config;
	state.trees = trees;
	if (!changed.length) {
		if (!state.queue.length) state.commit = commit;
		return false;
	}
	state.live = [
		...state.live.filter((path) => !relisted(path)),
		...fresh.map((file) => file.path),
	];
	state.queue = [
		...state.queue.filter((file) => !relisted(file.path)),
		...fresh.filter((file) => state.manifest[file.path] !== file.sha),
	];
	return true;
}

/** Queue drained: prune the manifest and R2 per owned dir (P8); a dir with an empty listing is left alone (likely a GitHub glitch) */
async function finishIlls(env: Env, state: IllState, target: string) {
	state.commit = target;
	if (!state.live.length) return;
	const keep = new Set(state.live);
	for (const path of Object.keys(state.manifest)) {
		if (!keep.has(path)) delete state.manifest[path];
	}
	for (const dir of dirsOf(env)) {
		const names = state.live
			.filter((path) => path.startsWith(`${dir}/`))
			.map((path) => path.slice(dir.length + 1));
		if (names.length)
			await dropStale(env.ILLS, r2Key(env, `${dir}/`), new Set(names));
	}
}

/** `lastError` is the run's first error; a run held back by the GitHub backoff keeps the one that set it */
function setRunError(
	state: QueueState,
	blocked: boolean,
	error: string | undefined,
) {
	if (!blocked || error) state.lastError = error;
}

export async function syncIlls(
	env: Env,
	opts: SyncOptions = {},
): Promise<IllState> {
	const now = opts.now ?? Date.now();
	const { state, baseline } = await loadIllState(env);
	const blocked = !opts.force && listBlocked(state, now);
	let listed = false;
	let error: string | undefined;
	if (!blocked) {
		try {
			listed = await refreshIllQueue(
				env,
				state,
				await headCommit(env, env.ILL_REPO, env.ILL_REF),
			);
			listOk(state);
		} catch (err) {
			error = errText(err);
			listFailed(state, now);
		}
	}
	const target = state.target;
	let run: RunSummary | undefined;
	if (target && state.queue.length) {
		run = await drain(state, target, (file) =>
			putGitBlob(
				env,
				env.ILL_REPO,
				target,
				file.path,
				r2Key(env, file.path),
				file.sha,
			),
		);
		error ??= run.error;
	}
	if (target && !state.queue.length && (listed || run)) {
		try {
			await finishIlls(env, state, target);
		} catch (err) {
			error ??= errText(err);
		}
	}
	setRunError(state, blocked, error);
	state.lastRun = run ?? idle(state, state.commit);
	await saveIfChanged(
		env.ILLS,
		ILL_STATE_KEY,
		state,
		() => illStateBody(state),
		baseline,
	);
	return state;
}

async function listHtml(env: Env, commit: string): Promise<FileEnt[]> {
	const html = htmlConfig(env);
	const keepByDir = new Map<string, Set<string> | null>();
	for (const dir of html.dirs) keepByDir.set(dir, null);
	for (const file of html.files) {
		const dir = dirOf(file);
		const cur = keepByDir.get(dir);
		if (cur === null) continue;
		const names = cur ?? new Set<string>();
		names.add(file.slice(dir.length + 1));
		keepByDir.set(dir, names);
	}
	const out: FileEnt[] = [];
	for (const [dir, keep] of keepByDir) {
		for (const ent of await listContents(env, infoRepo(env), commit, dir)) {
			if (!IMAGE_EXT.has(extOf(ent.name))) continue;
			if (keep && !keep.has(ent.name)) continue;
			out.push({
				path: `html/${dir}/${ent.name}`,
				sha: ent.sha,
				size: ent.size,
			});
		}
	}
	return out;
}

/** Queue the info files and the changed html files; if the html listing fails, the info files are still queued and `head` stays behind */
async function refreshInfoQueue(
	env: Env,
	state: InfoState,
	commit: string,
): Promise<boolean> {
	const config = await infoConfigKey(env);
	const sameConfig = state.config === config;
	if (sameConfig && state.target === commit && state.queue.length) return false;
	if (sameConfig && state.head === commit && !state.queue.length) return false;
	let html: FileEnt[] | undefined;
	let htmlError: unknown;
	try {
		html = await listHtml(env, commit);
	} catch (err) {
		htmlError = err;
	}

	const files = [
		...infoFileNames(env).map((path) => ({ path, sha: commit, size: 0 })),
		...(html ?? []),
	];
	if (state.target !== commit || !state.phigrosVerNum) {
		const ver = await readPhigrosVersion(
			infoRepo(env),
			commit,
			state.phigrosVerNum || 140,
		);
		if (ver) {
			state.phigros = ver.phigros;
			state.phigrosVerNum = ver.phigrosVerNum;
		}
	}
	state.target = commit;
	state.config = config;
	state.htmlCommit = html ? commit : undefined;
	if (html) state.live = html.map((file) => file.path);
	state.queue = files.filter((file) => state.manifest[file.path] !== file.sha);
	if (htmlError) throw htmlError;
	return true;
}

/** `commit` moves only when a mirrored info file changed (P5); without an html listing nothing is pruned and `head` stays behind */
async function finishInfo(env: Env, state: InfoState, target: string) {
	if (state.changed || !state.commit) state.commit = target;
	state.changed = undefined;
	if (state.htmlCommit !== target) return;
	state.head = target;
	const keep = new Set(state.live);
	for (const path of Object.keys(state.manifest)) {
		if (path.startsWith("html/") && !keep.has(path))
			delete state.manifest[path];
	}
	const htmlKeep = state.live.map(htmlRel);
	for (const dir of new Set(htmlKeep.map(dirOf).filter(Boolean))) {
		const dirKeep = new Set(
			htmlKeep
				.filter((path) => dirOf(path) === dir)
				.map((path) => path.slice(dir.length + 1)),
		);
		await dropStale(env.ILLS, `${htmlPrefixOf(env)}/${dir}/`, dirKeep);
	}
}

/** `levelsSha` hashes phi-unpackd's info file etags, so a new APK reloads consumers without a phi-plugin commit (P1) */
export async function syncLevels(env: Env, state: InfoState): Promise<boolean> {
	const prefix = `${infoPrefixOf(env)}/`;
	const etags = new Map<string, string>();
	let cursor: string | undefined;
	for (;;) {
		const page = await env.ILLS.list({ prefix, cursor, limit: 1000 });
		for (const obj of page.objects) {
			const name = obj.key.slice(prefix.length);
			if (APK_INFO_FILES.includes(name) && obj.etag) etags.set(name, obj.etag);
		}
		if (!page.truncated || !page.cursor) break;
		cursor = page.cursor;
	}
	if (!etags.size) throw new Error("no APK info files in R2 yet");
	const sha = await sha256Hex(
		APK_INFO_FILES.map((name) => `${name}:${etags.get(name) ?? ""}`).join("\n"),
	);
	state.levelsError = undefined;
	if (sha === state.levelsSha) return false;
	state.levelsSha = sha;
	const csv = await env.ILLS.get(`${prefix}info.csv`);
	if (csv) {
		const summary = summarizeInfoCsv(await csv.text());
		state.levelsSongs = summary.songs;
		state.levelsMax = summary.maxDifficulty;
	}
	return true;
}

async function syncTagTree(env: Env, state: InfoState): Promise<boolean> {
	const res = await fetch(tagTreeUrl(env), {
		headers: { Accept: "application/json", "User-Agent": "phi-ill-sync" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`tagTree ${res.status}`);
	const text = await res.text();
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object") throw new Error("tagTree invalid");
	const sha = await sha256Hex(text);
	state.tagTreeError = undefined;
	if (state.tagTreeSha === sha) return false;
	await env.ILLS.put(`${infoPrefixOf(env)}/tagTree.json`, text, {
		httpMetadata: {
			contentType: "application/json; charset=utf-8",
			cacheControl: NO_CACHE,
		},
		customMetadata: { tagTreeSha: sha },
	});
	state.tagTreeSha = sha;
	return true;
}

/** phib19 aliases, APK levels, the phi-plugin mirror and the tag tree, isolated so one failing source can't hold back the others */
export async function syncInfo(
	env: Env,
	opts: SyncOptions = {},
): Promise<InfoState> {
	const now = opts.now ?? Date.now();
	const { state, baseline } = await loadInfoState(env);
	await syncAliases(state, {
		bucket: env.ILLS,
		key: `${infoPrefixOf(env)}/aliases.json`,
		url: aliasExportUrl(env),
	});
	try {
		await syncLevels(env, state);
	} catch (err) {
		state.levelsError = errText(err);
	}
	const blocked = !opts.force && listBlocked(state, now);
	let listed = false;
	let error: string | undefined;
	if (!blocked) {
		try {
			listed = await refreshInfoQueue(
				env,
				state,
				await headCommit(env, infoRepo(env), infoRef(env)),
			);
			listOk(state);
		} catch (err) {
			error = errText(err);
			listFailed(state, now);
		}
	}
	const target = state.target;
	let run: RunSummary | undefined;
	if (target && state.queue.length) {
		const repo = infoRepo(env);
		run = await drain(state, target, async (file) => {
			if (file.path.startsWith("html/")) {
				return putGitBlob(
					env,
					repo,
					target,
					`resources/${file.path}`,
					`${htmlPrefixOf(env)}/${htmlRel(file.path)}`,
					file.sha,
				);
			}

			const known = state.manifest[file.path];
			const res = await putInfoFile(env, target, file.path, known);
			if (res.sha !== known) state.changed = true;
			return res;
		});
		error ??= run.error;
	}
	if (target && !state.queue.length && (listed || run)) {
		try {
			await finishInfo(env, state, target);
		} catch (err) {
			error ??= errText(err);
		}
	}
	setRunError(state, blocked, error);
	state.lastRun = run ?? idle(state, target);
	try {
		if (await syncTagTree(env, state)) state.lastRun.copied += 1;
	} catch (err) {
		state.tagTreeError = errText(err);
	}
	await saveIfChanged(
		env.ILLS,
		INFO_STATE_KEY,
		state,
		() => infoStateBody(state),
		baseline,
	);
	return state;
}
