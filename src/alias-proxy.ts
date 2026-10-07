import { DEFAULT_CHART_TAG_API } from "./chart-tag-proxy.ts";

const ALIAS_GET: Record<string, readonly string[]> = {
	"/aliases/resolve": ["alias"],
	"/aliases": ["limit", "offset"],
	"/alias-proposals/public": ["limit", "offset"],
	"/alias-proposals/export/nicklist.json": [],
};

export const MAX_ALIAS_LENGTH = 64;
export const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;
const MAX_OFFSET = 1_000_000;

export type AliasProxyTarget =
	| { ok: true; url: string }
	| { ok: false; error: string };

function routeOf(pathname: string): string {
	return pathname.replace(/\/+$/, "") || "/";
}

function paramsOf(path: string): readonly string[] | undefined {
	return Object.hasOwn(ALIAS_GET, path) ? ALIAS_GET[path] : undefined;
}

export function isAliasProxyPath(method: string, pathname: string): boolean {
	return method === "GET" && paramsOf(routeOf(pathname)) !== undefined;
}

function intParam(
	raw: string | null,
	min: number,
	max: number,
): number | undefined | "bad" {
	if (raw === null) return undefined;
	if (!/^\d{1,9}$/.test(raw)) return "bad";
	const n = Number(raw);
	return n >= min && n <= max ? n : "bad";
}

export function aliasProxyTarget(
	url: URL,
	origin = DEFAULT_CHART_TAG_API,
): AliasProxyTarget | undefined {
	const path = routeOf(url.pathname);
	const allowed = paramsOf(path);
	if (!allowed) return undefined;
	const params = url.searchParams;
	for (const name of new Set(params.keys())) {
		if (!allowed.includes(name))
			return { ok: false, error: `unexpected parameter ${name}` };
		if (params.getAll(name).length > 1)
			return { ok: false, error: `repeated parameter ${name}` };
	}
	const query: string[] = [];
	if (allowed.includes("alias")) {
		const alias = params.get("alias")?.trim() ?? "";
		if (!alias) return { ok: false, error: "alias is required" };
		if (alias.length > MAX_ALIAS_LENGTH) {
			return {
				ok: false,
				error: `alias is longer than ${MAX_ALIAS_LENGTH} characters`,
			};
		}
		query.push(`alias=${encodeURIComponent(alias)}`);
	}
	if (allowed.includes("limit")) {
		const limit = intParam(params.get("limit"), 1, MAX_PAGE);
		if (limit === "bad")
			return {
				ok: false,
				error: `limit must be an integer from 1 to ${MAX_PAGE}`,
			};
		const offset = intParam(params.get("offset"), 0, MAX_OFFSET);
		if (offset === "bad")
			return { ok: false, error: "offset must be a non-negative integer" };
		query.push(`limit=${limit ?? DEFAULT_PAGE}`, `offset=${offset ?? 0}`);
	}
	const base = origin.replace(/\/+$/, "");
	return {
		ok: true,
		url: `${base}${path}${query.length ? `?${query.join("&")}` : ""}`,
	};
}
