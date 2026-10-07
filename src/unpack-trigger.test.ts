import assert from "node:assert/strict";
import test from "node:test";
import { forwardUnpack } from "./unpack-trigger.ts";

test("forwardUnpack skips when the tunnel URL is unset", async () => {
	const res = await forwardUnpack({}, '{"check":true}', async () => {
		throw new Error("should not fetch");
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		skipped: true,
		reason: "UNPACK_URL unset",
	});
});

test("forwardUnpack posts the body and proxy key to the machine", async () => {
	let seen: { url?: string; key?: string; body?: string } = {};
	const res = await forwardUnpack(
		{ UNPACK_URL: "https://unpack.example/unpack", SYNC_SECRET: "sek" },
		'{"check":true}',
		async (url, init) => {
			seen = {
				url: String(url),
				key: new Headers(init?.headers).get("x-phi-proxy-key") || "",
				body: String(init?.body),
			};
			return new Response(JSON.stringify({ accepted: true }), {
				status: 202,
				headers: { "content-type": "application/json" },
			});
		},
	);
	assert.equal(seen.url, "https://unpack.example/unpack");
	assert.equal(seen.key, "sek");
	assert.equal(seen.body, '{"check":true}');
	assert.equal(res.status, 202);
	assert.deepEqual(await res.json(), { accepted: true });
});

test("forwardUnpack prefers UNPACK_SECRET over SYNC_SECRET", async () => {
	let key = "";
	await forwardUnpack(
		{
			UNPACK_URL: "https://unpack.example",
			UNPACK_SECRET: "machine",
			SYNC_SECRET: "sync",
		},
		"{}",
		async (_url, init) => {
			key = new Headers(init?.headers).get("x-phi-proxy-key") || "";
			return new Response("{}", { status: 200 });
		},
	);
	assert.equal(key, "machine");
});
