const TAP_HOST = /(?:^|\.)tapapis\.cn$|(?:^|\.)tapfiles\.cn$/i;

export function tapProxyTarget(
	raw: string | null | undefined,
): string | undefined {
	if (!raw) return;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return;
	if (!TAP_HOST.test(url.hostname)) return;
	return url.href;
}

export function tapProxyHeaders(req: Headers): Headers {
	const headers = new Headers();
	for (const name of [
		"accept",
		"content-type",
		"user-agent",
		"x-lc-id",
		"x-lc-key",
		"x-lc-session",
		"x-lc-sign",
	]) {
		const value = req.get(name);
		if (value) headers.set(name, value);
	}
	const auth = req.get("x-tap-authorization") || req.get("authorization");
	if (auth) headers.set("authorization", auth);
	if (!headers.has("user-agent")) headers.set("user-agent", "phi-ill-sync");
	return headers;
}
