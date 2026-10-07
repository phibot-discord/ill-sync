import { errText, NO_CACHE, type R2Bucket, sha256Hex } from "./env.ts";
import type { InfoState } from "./state.ts";

export const DEFAULT_ALIAS_EXPORT_URL =
	"https://phib19.top:8080/alias-proposals/export/nicklist.json";
const ALIAS_TIMEOUT_MS = 20_000;

export type AliasState = Pick<
	InfoState,
	| "aliasesSha"
	| "aliasesEtag"
	| "aliasesSongs"
	| "aliasesCount"
	| "aliasesError"
	| "aliasesCheckedAt"
>;

function invalid(why: string): Error {
	return new Error(`invalid alias snapshot: ${why}`);
}

function idWithout0(id: string): string {
	return id.endsWith(".0") ? id.slice(0, -2) : id;
}

export function validateAliasSnapshot(
	value: unknown,
): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalid("not an object");
	const out = new Map<string, string[]>();
	for (const [rawId, aliases] of Object.entries(value)) {
		const id = idWithout0(rawId.trim());
		if (!id) throw invalid("blank song id");
		if (out.has(id)) throw invalid(`duplicate song id ${id}`);
		if (!Array.isArray(aliases)) throw invalid(`${id} is not a list`);
		const list: string[] = [];
		for (const alias of aliases) {
			if (typeof alias !== "string")
				throw invalid(`${id} has a non-string alias`);
			const name = alias.normalize("NFC").trim();
			if (!name) throw invalid(`${id} has a blank alias`);
			if (!list.includes(name)) list.push(name);
		}
		out.set(id, list);
	}
	if (!out.size) throw invalid("empty");
	return Object.fromEntries(out);
}

export function canonicalAliases(
	data: Record<string, string[]>,
): Record<string, string[]> {
	return Object.fromEntries(
		Object.keys(data)
			.sort()
			.map((id) => [id, data[id] ?? []]),
	);
}

export function shrunk(
	prevCount: number | undefined,
	nextCount: number,
): boolean {
	return !!prevCount && nextCount < prevCount * 0.5;
}

type AliasDeps = {
	bucket: Pick<R2Bucket, "put">;
	key: string;
	url: string;
	fetch?: typeof fetch;
	now?: () => Date;
};

export async function syncAliases(
	state: AliasState,
	deps: AliasDeps,
): Promise<"updated" | "unchanged" | "not-modified" | "error"> {
	const now = deps.now?.() ?? new Date();
	state.aliasesCheckedAt = now.toISOString();
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": "phi-ill-sync",
		};
		if (state.aliasesEtag && state.aliasesSha)
			headers["If-None-Match"] = state.aliasesEtag;
		const res = await (deps.fetch ?? fetch)(deps.url, {
			headers,
			signal: AbortSignal.timeout(ALIAS_TIMEOUT_MS),
		});
		if (res.status === 304) {
			state.aliasesError = undefined;
			return "not-modified";
		}
		const type = res.headers.get("content-type") || "";
		if (!res.ok || !/\bjson\b/i.test(type)) {
			await res.body?.cancel().catch(() => {});
			throw new Error(
				res.ok
					? `aliases: expected JSON, got ${type || "no content-type"}`
					: `aliases ${res.status}`,
			);
		}
		const data = canonicalAliases(
			validateAliasSnapshot(JSON.parse(await res.text())),
		);
		const songs = Object.keys(data).length;
		const aliases = Object.values(data).reduce((n, list) => n + list.length, 0);
		if (shrunk(state.aliasesCount, aliases)) {
			throw new Error(
				`aliases: refused a shrink from ${state.aliasesCount} to ${aliases}`,
			);
		}
		const sha = await sha256Hex(JSON.stringify(data));
		const etag = res.headers.get("etag") || undefined;
		const changed = sha !== state.aliasesSha;
		if (changed) {
			const body = JSON.stringify({
				v: 1,
				sha,
				fetchedAt: now.toISOString(),
				upstreamEtag: etag ?? null,
				songs,
				aliases,
				data,
			});
			await deps.bucket.put(deps.key, body, {
				httpMetadata: {
					contentType: "application/json; charset=utf-8",
					cacheControl: NO_CACHE,
				},
				customMetadata: { aliasesSha: sha },
			});
		}
		state.aliasesSha = sha;
		state.aliasesEtag = etag;
		state.aliasesSongs = songs;
		state.aliasesCount = aliases;
		state.aliasesError = undefined;
		return changed ? "updated" : "unchanged";
	} catch (err) {
		state.aliasesError = errText(err).slice(0, 300);
		return "error";
	}
}
