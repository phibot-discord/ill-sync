import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchUpstream,
	proxyAlias,
	proxyChartTag,
	proxyTap,
	relay,
	UPSTREAM_ACCEPT_ENCODING,
} from "./proxy.ts";

const ORIGIN = "https://phib19.test";
type Call = { url: string; init: RequestInit };

function recorder(
	handler: (call: Call, n: number) => Response | Promise<Response>,
) {
	const calls: Call[] = [];
	const impl = (async (url: unknown, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return handler(call, calls.length);
	}) as typeof fetch;
	return { calls, impl };
}

/** Never answers; rejects when the signal aborts, like fetch does */
function hang(call: Call): Promise<Response> {
	return new Promise((_, reject) => {
		call.init.signal?.addEventListener("abort", () =>
			reject(new DOMException("aborted", "AbortError")),
		);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("only the wait for headers is timed; a slow body keeps streaming", async () => {
	let signal: AbortSignal | undefined;
	const { impl } = recorder((call) => {
		signal = call.init.signal ?? undefined;
		const body = new ReadableStream<Uint8Array>({
			async start(ctrl) {
				ctrl.enqueue(new TextEncoder().encode('{"a":'));
				await sleep(60);
				ctrl.enqueue(new TextEncoder().encode("1}"));
				ctrl.close();
			},
		});
		return new Response(body, {
			headers: { "content-type": "application/json" },
		});
	});
	const res = await fetchUpstream(`${ORIGIN}/x`, {}, 20, impl);
	assert.deepEqual(await res.json(), { a: 1 });
	assert.equal(signal?.aborted, false);
});

test("no headers within the budget is a timeout, and it is not retried", async () => {
	const { calls, impl } = recorder(hang);
	await assert.rejects(
		fetchUpstream(`${ORIGIN}/x`, {}, 20, impl),
		/no response headers within 20 ms/,
	);
	assert.equal(calls.length, 1);
});

test("GET and HEAD get one retry after a connection error; POST gets none", async () => {
	for (const method of ["GET", "HEAD"]) {
		const { calls, impl } = recorder((_, n) => {
			if (n === 1) throw new TypeError("connect failed");
			return new Response("ok");
		});
		const res = await fetchUpstream(`${ORIGIN}/x`, { method }, 1000, impl);
		assert.equal(await res.text(), "ok");
		assert.equal(calls.length, 2, method);
	}
	const post = recorder(() => {
		throw new TypeError("connect failed");
	});
	await assert.rejects(
		fetchUpstream(
			`${ORIGIN}/x`,
			{ method: "POST", body: "{}" },
			1000,
			post.impl,
		),
		/connect failed/,
	);
	assert.equal(post.calls.length, 1);
	const twice = recorder(() => {
		throw new TypeError("connect failed");
	});
	await assert.rejects(
		fetchUpstream(`${ORIGIN}/x`, {}, 1000, twice.impl),
		/connect failed/,
	);
	assert.equal(twice.calls.length, 2);
});

test("relay keeps status, type, etag, last-modified, and content-length of unencoded bodies", async () => {
	const res = relay(
		new Response("hello", {
			status: 201,
			headers: {
				"content-type": "text/plain",
				etag: 'W/"5-x"',
				"last-modified": "Tue, 06 Oct 2026 00:00:00 GMT",
				"content-length": "5",
				"set-cookie": "a=b",
				"x-signature": "sig",
			},
		}),
		"application/json",
	);
	assert.equal(res.status, 201);
	assert.equal(res.headers.get("content-type"), "text/plain");
	assert.equal(res.headers.get("etag"), 'W/"5-x"');
	assert.equal(
		res.headers.get("last-modified"),
		"Tue, 06 Oct 2026 00:00:00 GMT",
	);
	assert.equal(res.headers.get("content-length"), "5");
	assert.equal(res.headers.get("set-cookie"), null);
	assert.equal(await res.text(), "hello");

	// An encoded body passes through under its encoding; its length may change on the way out
	const bytes = new Uint8Array([0x0b, 0x00, 0x80, 0x7b, 0x7d, 0x03]);
	const br = relay(
		new Response(bytes, {
			headers: { "content-encoding": "br", "content-length": "6" },
		}),
		"application/json",
	);
	assert.equal(br.headers.get("content-encoding"), "br");
	assert.equal(br.headers.get("content-length"), null);
	assert.equal(br.headers.get("content-type"), "application/json");
	assert.deepEqual(
		new Uint8Array(await br.arrayBuffer()),
		bytes,
		"the bytes are not touched",
	);
	const gzip = relay(
		new Response("x", { headers: { "content-encoding": " GZIP " } }),
		"application/json",
	);
	assert.equal(gzip.headers.get("content-encoding"), "gzip");
	const identity = relay(
		new Response("{}", {
			headers: { "content-encoding": "identity", "content-length": "2" },
		}),
		"application/json",
	);
	assert.equal(identity.headers.get("content-encoding"), null);
	assert.equal(identity.headers.get("content-length"), "2");

	const notModified = relay(
		new Response(null, {
			status: 304,
			headers: { etag: 'W/"1"', "content-encoding": "br" },
		}),
		"application/json",
	);
	assert.equal(notModified.status, 304);
	assert.equal(notModified.headers.get("content-encoding"), null);
	assert.equal(notModified.headers.get("etag"), 'W/"1"');
	assert.equal(notModified.body, null);
});

test("alias proxy: bad queries get 400 JSON without touching upstream", async () => {
	const { calls, impl } = recorder(() => new Response("{}"));
	const res = await proxyAlias(
		new Request("https://w.test/aliases?limit=1000"),
		ORIGIN,
		impl,
	);
	assert.equal(res?.status, 400);
	assert.match(
		String(((await res?.json()) as { error: string }).error),
		/limit/,
	);
	assert.equal(calls.length, 0);
	assert.equal(
		await proxyAlias(new Request("https://w.test/aliases/list"), ORIGIN, impl),
		undefined,
	);
	assert.equal(
		await proxyAlias(
			new Request("https://w.test/aliases", { method: "POST" }),
			ORIGIN,
			impl,
		),
		undefined,
	);
});

test("alias proxy: forwards If-None-Match, returns the ETag, and passes a 304 through", async () => {
	const { calls, impl } = recorder((call, n) => {
		if (n === 1) {
			return new Response('{"items":[]}', {
				headers: {
					"content-type": "application/json; charset=utf-8",
					etag: 'W/"c-1"',
				},
			});
		}
		assert.equal(
			new Headers(call.init.headers).get("if-none-match"),
			'W/"c-1"',
		);
		return new Response(null, { status: 304, headers: { etag: 'W/"c-1"' } });
	});
	const first = await proxyAlias(
		new Request("https://w.test/aliases/resolve?alias=ASA&"),
		ORIGIN,
		impl,
	);
	assert.equal(first?.status, 200);
	assert.equal(first?.headers.get("etag"), 'W/"c-1"');
	assert.deepEqual(await first?.json(), { items: [] });
	assert.equal(calls[0]?.url, `${ORIGIN}/aliases/resolve?alias=ASA`);
	assert.equal(new Headers(calls[0]?.init.headers).get("if-none-match"), null);

	const again = await proxyAlias(
		new Request("https://w.test/aliases/resolve?alias=ASA", {
			headers: { "if-none-match": 'W/"c-1"' },
		}),
		ORIGIN,
		impl,
	);
	assert.equal(again?.status, 304);
	assert.equal(again?.headers.get("etag"), 'W/"c-1"');
});

test("alias proxy: an HTML upstream answer becomes 502 JSON", async () => {
	const { impl } = recorder(
		() =>
			new Response("<pre>ZodError: at /srv/app.js</pre>", {
				status: 500,
				headers: { "content-type": "text/html" },
			}),
	);
	const res = await proxyAlias(
		new Request("https://w.test/aliases?limit=5"),
		ORIGIN,
		impl,
	);
	assert.equal(res?.status, 502);
	const text = (await res?.text()) ?? "";
	assert.doesNotMatch(text, /ZodError|app\.js/);
	assert.deepEqual(JSON.parse(text), { error: "upstream", status: 500 });
});

test("alias proxy: a header timeout is a 504 JSON", async () => {
	const { impl } = recorder(() => {
		throw new TypeError("network down");
	});
	const res = await proxyAlias(
		new Request("https://w.test/alias-proposals/export/nicklist.json"),
		ORIGIN,
		impl,
	);
	assert.equal(res?.status, 504);
	assert.match(
		String(((await res?.json()) as { error: string }).error),
		/network down/,
	);
});

test("chart-tag proxy: POST forwards the body once, GET drops the query and forwards If-None-Match", async () => {
	const { calls, impl } = recorder(() => {
		throw new TypeError("connect failed");
	});
	const res = await proxyChartTag(
		new Request("https://w.test/get/scoreList/songAccList", {
			method: "POST",
			body: '{"songId":"a.0"}',
		}),
		ORIGIN,
		impl,
	);
	assert.equal(res?.status, 504);
	assert.equal(calls.length, 1, "POST is not retried");
	assert.equal(calls[0]?.init.body, '{"songId":"a.0"}');
	assert.equal(
		new Headers(calls[0]?.init.headers).get("content-type"),
		"application/json",
	);

	const ok = recorder(
		() =>
			new Response("[]", {
				headers: { "content-type": "application/json", etag: '"t"' },
			}),
	);
	const tree = await proxyChartTag(
		new Request("https://w.test/chartsTag/get/tagTree?x=1", {
			headers: { "if-none-match": '"t0"' },
		}),
		ORIGIN,
		ok.impl,
	);
	assert.equal(tree?.headers.get("etag"), '"t"');
	assert.equal(ok.calls[0]?.url, `${ORIGIN}/chartsTag/get/tagTree`);
	const sent = new Headers(ok.calls[0]?.init.headers);
	assert.equal(sent.get("if-none-match"), '"t0"');
	assert.equal(sent.get("content-type"), null);
	assert.equal(
		await proxyChartTag(
			new Request("https://w.test/get/scoreList/user", { method: "POST" }),
			ORIGIN,
			ok.impl,
		),
		undefined,
	);
});

test("tap proxy: POST is sent once, GET is retried on a connection error", async () => {
	const headers = { "x-tap-target": "https://a.tapapis.cn/1.1/x" };
	const post = recorder(() => {
		throw new TypeError("connect failed");
	});
	const res = await proxyTap(
		new Request("https://w.test/tap-proxy", {
			method: "POST",
			headers,
			body: "{}",
		}),
		post.impl,
	);
	assert.equal(res?.status, 504);
	assert.equal(post.calls.length, 1);

	const get = recorder((_, n) => {
		if (n === 1) throw new TypeError("connect failed");
		return new Response("zip", {
			headers: { "content-type": "application/zip", "content-length": "3" },
		});
	});
	const ok = await proxyTap(
		new Request("https://w.test/tap-proxy", { headers }),
		get.impl,
	);
	assert.equal(get.calls.length, 2);
	assert.equal(ok?.headers.get("content-type"), "application/zip");
	assert.equal(ok?.headers.get("content-length"), "3");
	assert.equal(await ok?.text(), "zip");

	const bad = await proxyTap(
		new Request("https://w.test/tap-proxy", {
			headers: { "x-tap-target": "https://evil.test/" },
		}),
	);
	assert.equal(bad?.status, 404);
});

test("phib19 proxies ask upstream for brotli or gzip and relay the compressed body as is", async () => {
	const packed = new Uint8Array([1, 2, 3, 4]);
	const upstream = () =>
		new Response(packed, {
			headers: {
				"content-type": "application/json",
				"content-encoding": "br",
				"content-length": "4",
			},
		});
	const tag = recorder(upstream);
	const analysis = await proxyChartTag(
		new Request("https://w.test/chartsTag/get/b30Analysis", {
			method: "POST",
			body: "{}",
			headers: { "accept-encoding": "identity" },
		}),
		ORIGIN,
		tag.impl,
	);
	assert.equal(
		new Headers(tag.calls[0]?.init.headers).get("accept-encoding"),
		UPSTREAM_ACCEPT_ENCODING,
	);
	assert.equal(analysis?.headers.get("content-encoding"), "br");
	assert.equal(analysis?.headers.get("content-length"), null);
	assert.deepEqual(
		new Uint8Array((await analysis?.arrayBuffer()) ?? new ArrayBuffer(0)),
		packed,
	);

	const alias = recorder(upstream);
	const resolved = await proxyAlias(
		new Request("https://w.test/aliases/resolve?alias=ASA"),
		ORIGIN,
		alias.impl,
	);
	assert.equal(
		new Headers(alias.calls[0]?.init.headers).get("accept-encoding"),
		UPSTREAM_ACCEPT_ENCODING,
	);
	assert.equal(resolved?.headers.get("content-encoding"), "br");
});
