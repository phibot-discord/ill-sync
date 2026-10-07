import { isAliasProxyPath } from "./alias-proxy.ts";
import { chartTagProxyUrl, DEFAULT_CHART_TAG_API } from "./chart-tag-proxy.ts";
import { type Env, errText } from "./env.ts";
import { proxyAlias, proxyChartTag, proxyTap } from "./proxy.ts";
import { bearerAuthorized, proxyAuthorized } from "./proxy-auth.ts";
import { publicIllState, publicInfoState } from "./state.ts";
import { loadIllState, loadInfoState, syncIlls, syncInfo } from "./sync.ts";
import { forwardUnpack } from "./unpack-trigger.ts";

function chartTagApi(env: Env): string {
	return env.CHART_TAG_API?.trim() || DEFAULT_CHART_TAG_API;
}

async function syncAll(env: Env, force: boolean) {
	let info: ReturnType<typeof publicInfoState> | { lastError: string };
	let ill: ReturnType<typeof publicIllState> | { lastError: string };
	try {
		info = publicInfoState(await syncInfo(env, { force }));
	} catch (err) {
		info = { lastError: errText(err) };
	}
	try {
		ill = publicIllState(await syncIlls(env, { force }));
	} catch (err) {
		ill = { lastError: errText(err) };
	}
	return { info, ill };
}

export default {
	async scheduled(_controller: { cron: string }, env: Env) {
		const { info, ill } = await syncAll(env, false);
		console.log("info-sync", JSON.stringify(info));
		console.log("ill-sync", JSON.stringify(ill));
		if (env.UNPACK_URL?.trim()) {
			try {
				const unpacked = await forwardUnpack(env, '{"check":true}');
				console.log("unpack", unpacked.status, await unpacked.text());
			} catch (err) {
				console.log("unpack", JSON.stringify({ lastError: errText(err) }));
			}
		}
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const api = chartTagApi(env);
		const isProxy =
			url.pathname === "/tap-proxy" ||
			Boolean(chartTagProxyUrl(req.method, url.pathname, api)) ||
			isAliasProxyPath(req.method, url.pathname);
		if (isProxy) {
			if (!proxyAuthorized(req.headers, env.PROXY_SECRET)) {
				return new Response("unauthorized", { status: 401 });
			}
			const proxied =
				(await proxyTap(req)) ??
				(await proxyChartTag(req, api)) ??
				(await proxyAlias(req, api));
			if (proxied) return proxied;
		}
		const secrets = [env.SYNC_SECRET, env.PROXY_SECRET, env.UNPACK_SECRET];
		if (!bearerAuthorized(req.headers.get("authorization"), secrets)) {
			return new Response("not found", { status: 404 });
		}
		if (req.method === "GET" && url.pathname === "/") {
			return Response.json(publicIllState((await loadIllState(env)).state));
		}
		if (req.method === "GET" && url.pathname === "/info") {
			return Response.json(publicInfoState((await loadInfoState(env)).state));
		}
		if (req.method === "POST" && url.pathname === "/unpack") {
			return forwardUnpack(env, await req.text());
		}
		if (
			(req.method === "POST" || req.method === "GET") &&
			url.pathname === "/sync"
		) {
			return Response.json(await syncAll(env, true));
		}
		return new Response("not found", { status: 404 });
	},
};
