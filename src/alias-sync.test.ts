import assert from "node:assert/strict";
import test from "node:test";
import {
	type AliasState,
	canonicalAliases,
	shrunk,
	syncAliases,
	validateAliasSnapshot,
} from "./alias-sync.ts";
import { sha256Hex } from "./env.ts";
import { FakeBucket, json } from "./test-fakes.ts";

const URL_ = "https://phib19.test/alias-proposals/export/nicklist.json";
const KEY = "info/aliases.json";
const snapshot = {
	"Glaciaxion.SunsetRay": ["冰", " 冰河 "],
	"000AinSophAur.Yumeji": ["ASA", "000"],
};

function run(
	state: AliasState,
	bucket: FakeBucket,
	res: Response | Error,
	seen: RequestInit[] = [],
) {
	return syncAliases(state, {
		bucket,
		key: KEY,
		url: URL_,
		now: () => new Date("2026-10-06T00:00:00Z"),
		fetch: (async (_url: unknown, init?: RequestInit) => {
			if (init) seen.push(init);
			if (res instanceof Error) throw res;
			return res;
		}) as typeof fetch,
	});
}

test("validateAliasSnapshot trims, drops repeats and strips a trailing .0 from ids", () => {
	assert.deepEqual(
		validateAliasSnapshot({ " A.b.0 ": [" x ", "x", "y"], C: ["z"] }),
		{ "A.b": ["x", "y"], C: ["z"] },
	);
	assert.deepEqual(validateAliasSnapshot({ A: ["é", "é"] }), { A: ["é"] });
});

test("validateAliasSnapshot rejects the whole snapshot on any bad entry", () => {
	const bad: unknown[] = [
		null,
		[],
		"x",
		{},
		{ "": ["a"] },
		{ " ": ["a"] },
		{ A: "a" },
		{ A: ["a", 7] },
		{ A: ["a", " "] },
		{ A: ["a"], "A.0": ["b"] },
	];
	for (const value of bad)
		assert.throws(
			() => validateAliasSnapshot(value),
			/invalid alias snapshot/,
			JSON.stringify(value),
		);
});

test("canonical form does not depend on upstream key order", async () => {
	const a = canonicalAliases({ b: ["1"], a: ["2", "1"] });
	const b = canonicalAliases({ a: ["2", "1"], b: ["1"] });
	assert.deepEqual(Object.keys(a), ["a", "b"]);
	assert.equal(
		await sha256Hex(JSON.stringify(a)),
		await sha256Hex(JSON.stringify(b)),
	);
});

test("shrink guard rejects a drop of more than half", () => {
	assert.equal(shrunk(undefined, 1), false);
	assert.equal(shrunk(1936, 968), false);
	assert.equal(shrunk(1936, 967), true);
});

test("a new snapshot is written to R2 with sha, counts and upstream etag", async () => {
	const bucket = new FakeBucket();
	const state: AliasState = {};
	const seen: RequestInit[] = [];
	const res = json(snapshot, { headers: { etag: 'W/"7ed0-abc"' } });
	assert.equal(await run(state, bucket, res, seen), "updated");
	assert.equal(new Headers(seen[0]?.headers).get("if-none-match"), null);
	const body = bucket.json(KEY);
	const data = {
		"000AinSophAur.Yumeji": ["ASA", "000"],
		"Glaciaxion.SunsetRay": ["冰", "冰河"],
	};
	assert.deepEqual(body, {
		v: 1,
		sha: await sha256Hex(JSON.stringify(data)),
		fetchedAt: "2026-10-06T00:00:00.000Z",
		upstreamEtag: 'W/"7ed0-abc"',
		songs: 2,
		aliases: 4,
		data,
	});
	const meta = bucket.objects.get(KEY)?.options;
	assert.equal(
		meta?.httpMetadata?.contentType,
		"application/json; charset=utf-8",
	);
	assert.equal(meta?.httpMetadata?.cacheControl, "no-cache");
	assert.equal(meta?.customMetadata?.aliasesSha, body.sha);
	assert.equal(state.aliasesSha, body.sha);
	assert.equal(state.aliasesEtag, 'W/"7ed0-abc"');
	assert.equal(state.aliasesSongs, 2);
	assert.equal(state.aliasesCount, 4);
	assert.equal(state.aliasesError, undefined);
	assert.equal(state.aliasesCheckedAt, "2026-10-06T00:00:00.000Z");
});

test("304 is handled before res.ok: no error, no write, If-None-Match sent", async () => {
	const bucket = new FakeBucket();
	const state: AliasState = {
		aliasesSha: "s",
		aliasesEtag: 'W/"1"',
		aliasesCount: 4,
		aliasesError: "old",
	};
	const seen: RequestInit[] = [];
	assert.equal(
		await run(state, bucket, new Response(null, { status: 304 }), seen),
		"not-modified",
	);
	assert.equal(new Headers(seen[0]?.headers).get("if-none-match"), 'W/"1"');
	assert.equal(state.aliasesError, undefined);
	assert.equal(state.aliasesSha, "s");
	assert.equal(bucket.count("put"), 0);
});

test("same content under a new etag updates the etag but not R2", async () => {
	const bucket = new FakeBucket();
	const state: AliasState = {};
	await run(state, bucket, json(snapshot, { headers: { etag: 'W/"1"' } }));
	const puts = bucket.count("put");
	const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
	assert.equal(
		await run(state, bucket, json(reordered, { headers: { etag: 'W/"2"' } })),
		"unchanged",
	);
	assert.equal(bucket.count("put"), puts);
	assert.equal(state.aliasesEtag, 'W/"2"');
});

test("upstream failures keep the previous copy and record aliasesError", async () => {
	const cases: [string, Response | Error, RegExp][] = [
		[
			"html 500",
			new Response("<pre>ZodError</pre>", {
				status: 500,
				headers: { "content-type": "text/html" },
			}),
			/aliases 500/,
		],
		[
			"html 200",
			new Response("<html>", { headers: { "content-type": "text/html" } }),
			/expected JSON/,
		],
		["no type", new Response("{}"), /expected JSON/],
		[
			"bad json",
			new Response("{", { headers: { "content-type": "application/json" } }),
			/JSON/,
		],
		["invalid", json({ A: [1] }), /invalid alias snapshot/],
		["network", new TypeError("fetch failed"), /fetch failed/],
	];
	for (const [name, res, error] of cases) {
		const bucket = new FakeBucket();
		const state: AliasState = {
			aliasesSha: "prev",
			aliasesCount: 4,
			aliasesEtag: 'W/"1"',
		};
		assert.equal(await run(state, bucket, res), "error", name);
		assert.match(state.aliasesError ?? "", error, name);
		assert.equal(state.aliasesSha, "prev", name);
		assert.equal(state.aliasesEtag, 'W/"1"', name);
		assert.equal(bucket.count("put"), 0, name);
	}
});

test("a snapshot with less than half the aliases is refused", async () => {
	const bucket = new FakeBucket();
	const state: AliasState = { aliasesSha: "prev", aliasesCount: 1936 };
	assert.equal(await run(state, bucket, json(snapshot)), "error");
	assert.match(state.aliasesError ?? "", /shrink from 1936 to 4/);
	assert.equal(state.aliasesSha, "prev");
	assert.equal(bucket.count("put"), 0);
});
