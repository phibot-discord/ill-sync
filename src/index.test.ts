import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.ts";
import { FakeBucket, json, stubFetch, testEnv } from "./test-fakes.ts";

const env = (bucket = new FakeBucket()) =>
	testEnv(bucket, {
		PROXY_SECRET: "proxy",
		SYNC_SECRET: "sync",
		CHART_TAG_API: "https://phib19.test",
	});
const call = (path: string, init: RequestInit = {}, e = env()) =>
	worker.fetch(new Request(`https://w.test${path}`, init), e);

test("alias routes sit behind the proxy key like the other proxies", async () => {
	const stub = stubFetch((url) =>
		url.startsWith("https://phib19.test/") ? json({ items: [] }) : undefined,
	);
	try {
		assert.equal((await call("/aliases/resolve?alias=ASA")).status, 401);
		assert.equal(
			(
				await call("/aliases/resolve?alias=ASA", {
					headers: { "x-phi-proxy-key": "nope" },
				})
			).status,
			401,
		);
		const res = await call("/aliases/resolve?alias=ASA", {
			headers: { "x-phi-proxy-key": "proxy" },
		});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { items: [] });
		assert.equal(
			stub.calls[0]?.url,
			"https://phib19.test/aliases/resolve?alias=ASA",
		);
		const bad = await call("/aliases?limit=999", {
			headers: { "x-phi-proxy-key": "proxy" },
		});
		assert.equal(bad.status, 400);
		assert.equal(stub.calls.length, 1);
		const posted = await call("/get/scoreList/songAccList", {
			method: "POST",
			headers: { "x-phi-proxy-key": "proxy" },
			body: "{}",
		});
		assert.equal(posted.status, 200);
		assert.equal(
			stub.calls[1]?.url,
			"https://phib19.test/get/scoreList/songAccList",
		);
	} finally {
		stub.restore();
	}
});

test("unknown routes and admin routes without a bearer secret are 404", async () => {
	assert.equal(
		(await call("/aliases/list", { headers: { "x-phi-proxy-key": "proxy" } }))
			.status,
		404,
	);
	assert.equal(
		(
			await call("/get/scoreList/user", {
				method: "POST",
				headers: { "x-phi-proxy-key": "proxy" },
			})
		).status,
		404,
	);
	assert.equal((await call("/info")).status, 404);
	assert.equal(
		(await call("/info", { headers: { authorization: "Bearer wrong" } }))
			.status,
		404,
	);
});

test("GET /info reports pending as a number, migrating an old state", async () => {
	const bucket = new FakeBucket();
	bucket.seed(
		"_sync/info.json",
		JSON.stringify({
			commit: "c",
			pending: [{ path: "chaplist.yaml", sha: "c", size: 0 }],
		}),
	);
	const res = await call(
		"/info",
		{ headers: { authorization: "Bearer sync" } },
		env(bucket),
	);
	const body = (await res.json()) as Record<string, unknown>;
	assert.equal(body.pending, 1);
	assert.equal(body.commit, "c");
});
