import { aliasProxyTarget, isAliasProxyPath } from "./alias-proxy.ts";
import { chartTagProxyUrl } from "./chart-tag-proxy.ts";
import { errText } from "./env.ts";
import { tapProxyHeaders, tapProxyTarget } from "./tap-proxy.ts";

export const TAP_TIMEOUT_MS = 45_000;
/** phib19 answers within ~1–8 s but can stream a body for 10–30 s more; only the headers are timed */
export const PHIB19_TIMEOUT_MS = 25_000;
const UA = "phi-ill-sync";
const NULL_BODY = new Set([204, 205, 304]);
/** Ask phib19 for brotli whatever the client sent (a cold b30Analysis is ~156 KB, ~11 KB compressed); relay() passes it through */
export const UPSTREAM_ACCEPT_ENCODING = "br, gzip";

type Fetch = typeof fetch;

/** Times out only the wait for headers, then the body streams; GET/HEAD retry once after a connection error, never after a timeout */
export async function fetchUpstream(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	fetchImpl: Fetch = fetch,
): Promise<Response> {
	const method = (init.method || "GET").toUpperCase();
	const attempts = method === "GET" || method === "HEAD" ? 2 : 1;
	for (let attempt = 1; ; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			return await fetchImpl(url, { ...init, signal: ctrl.signal });
		} catch (err) {
			if (ctrl.signal.aborted)
				throw new Error(
					`upstream sent no response headers within ${timeoutMs} ms`,
				);
			if (attempt >= attempts) throw err;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Upstream status and body with content-type, etag, last-modified, content-encoding and, for identity bodies, content-length
 * Keeping Content-Encoding lets the Workers runtime pass the body through compressed (it re-encodes only if the client needs it)
 */
export function relay(res: Response, fallbackType: string): Response {
	const headers = new Headers({
		"content-type": res.headers.get("content-type") || fallbackType,
	});
	for (const name of ["etag", "last-modified"]) {
		const value = res.headers.get(name);
		if (value) headers.set(name, value);
	}
	const nullBody = NULL_BODY.has(res.status);
	const encoding =
		res.headers.get("content-encoding")?.trim().toLowerCase() || "identity";
	if (encoding !== "identity" && !nullBody)
		headers.set("content-encoding", encoding);
	const length = res.headers.get("content-length");
	if (encoding === "identity" && length && /^\d+$/.test(length)) {
		headers.set("content-length", length);
	}
	return new Response(nullBody ? null : res.body, {
		status: res.status,
		headers,
	});
}

function failed(err: unknown): Response {
	return Response.json({ error: errText(err) }, { status: 504 });
}

export async function proxyTap(
	req: Request,
	fetchImpl: Fetch = fetch,
): Promise<Response | undefined> {
	if (new URL(req.url).pathname !== "/tap-proxy") return;
	const dest = tapProxyTarget(req.headers.get("x-tap-target"));
	if (!dest) return new Response("not found", { status: 404 });
	const body =
		req.method === "GET" || req.method === "HEAD"
			? undefined
			: await req.arrayBuffer();
	try {
		const res = await fetchUpstream(
			dest,
			{ method: req.method, headers: tapProxyHeaders(req.headers), body },
			TAP_TIMEOUT_MS,
			fetchImpl,
		);
		return relay(res, "application/octet-stream");
	} catch (err) {
		return failed(err);
	}
}

export async function proxyChartTag(
	req: Request,
	origin: string,
	fetchImpl: Fetch = fetch,
): Promise<Response | undefined> {
	const dest = chartTagProxyUrl(req.method, new URL(req.url).pathname, origin);
	if (!dest) return;
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Accept-Encoding": UPSTREAM_ACCEPT_ENCODING,
		"User-Agent": UA,
	};
	let body: string | undefined;
	if (req.method === "POST") {
		headers["Content-Type"] = "application/json";
		body = await req.text();
	} else {
		const tag = req.headers.get("if-none-match");
		if (tag) headers["If-None-Match"] = tag;
	}
	try {
		const res = await fetchUpstream(
			dest,
			{ method: req.method, headers, body },
			PHIB19_TIMEOUT_MS,
			fetchImpl,
		);
		return relay(res, "application/json");
	} catch (err) {
		return failed(err);
	}
}

export async function proxyAlias(
	req: Request,
	origin: string,
	fetchImpl: Fetch = fetch,
): Promise<Response | undefined> {
	const url = new URL(req.url);
	if (!isAliasProxyPath(req.method, url.pathname)) return;
	const target = aliasProxyTarget(url, origin);
	if (!target) return;
	if (!target.ok)
		return Response.json({ error: target.error }, { status: 400 });
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Accept-Encoding": UPSTREAM_ACCEPT_ENCODING,
		"User-Agent": UA,
	};
	const tag = req.headers.get("if-none-match");
	if (tag) headers["If-None-Match"] = tag;
	try {
		const res = await fetchUpstream(
			target.url,
			{ headers },
			PHIB19_TIMEOUT_MS,
			fetchImpl,
		);
		if (
			res.status !== 304 &&
			!/\bjson\b/i.test(res.headers.get("content-type") || "")
		) {
			await res.body?.cancel().catch(() => {});
			return Response.json(
				{ error: "upstream", status: res.status },
				{ status: 502 },
			);
		}
		return relay(res, "application/json");
	} catch (err) {
		return failed(err);
	}
}
