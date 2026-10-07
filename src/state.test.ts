import assert from "node:assert/strict";
import test from "node:test";
import {
	illStateBody,
	infoStateBody,
	listBlocked,
	listFailed,
	listOk,
	loadRaw,
	parseIllState,
	parseInfoState,
	publicInfoState,
	saveIfChanged,
	stableKey,
} from "./state.ts";
import { FakeBucket } from "./test-fakes.ts";

const sp = (path: string) => path.startsWith("SP/") || path.startsWith("chap/");

test("old state with a pending array migrates to queue, and pending is written as a count", () => {
	const old = {
		commit: "c1",
		target: "c1",
		pending: [
			{ path: "chaplist.yaml", sha: "c1", size: 0 },
			{ path: "tips.txt", sha: "c1", size: 0 },
			{ path: "html/avatar/x.png", sha: "s", size: 1 },
		],
		manifest: {
			"chaplist.yaml": "a",
			"info.csv": "b",
			"tagTree.json": "c",
			"html/otherimg/A.png": "d",
		},
		live: ["html/otherimg/A.png", "html/avatar/x.png"],
		levelsSha: "lv",
		tagTreeSha: "tt",
	};
	const keep = (path: string) =>
		path === "chaplist.yaml" || path === "html/otherimg/A.png";
	const state = parseInfoState(old, keep);
	// P3: entries outside the current config (APK files, html/avatar) are dropped on load
	assert.deepEqual(state.queue, [
		{ path: "chaplist.yaml", sha: "c1", size: 0 },
	]);
	assert.deepEqual(state.manifest, {
		"chaplist.yaml": "a",
		"html/otherimg/A.png": "d",
	});
	assert.deepEqual(state.live, ["html/otherimg/A.png"]);
	assert.equal(state.head, undefined);
	assert.equal(state.levelsSha, "lv");
	assert.equal(state.tagTreeSha, "tt");

	const body = infoStateBody(state);
	assert.equal(body.pending, 1);
	assert.deepEqual(body.queue, state.queue);
	assert.equal(publicInfoState(state).pending, 1);
});

test("a stored body round-trips, and an empty queue reads as ready (commit set, pending 0)", () => {
	const state = parseInfoState({}, () => true);
	state.commit = "c2";
	state.head = "c3";
	state.htmlCommit = "c3";
	state.aliasesSha = "al";
	state.aliasesCount = 3;
	const stored = JSON.parse(JSON.stringify(infoStateBody(state))) as Record<
		string,
		unknown
	>;
	assert.equal(stored.pending, 0);
	assert.equal(stored.commit, "c2");
	assert.equal(stored.aliasesSha, "al");
	const again = parseInfoState(stored, () => true);
	// parse then body is the identity, so an idle run compares equal (P9)
	assert.equal(stableKey(infoStateBody(again)), stableKey(stored));
	assert.equal(again.head, "c3");
	assert.equal(again.htmlCommit, "c3");
	assert.equal(again.aliasesSha, "al");
	assert.equal(again.aliasesCount, 3);
	assert.deepEqual(again.queue, []);
});

test("ill state keeps only wanted paths and the trees of current dirs", () => {
	const state = parseIllState(
		{
			commit: "c",
			pending: [
				{ path: "illLow/a.png", sha: "1", size: 1 },
				{ path: "SP/b.png", sha: "2", size: 2 },
			],
			manifest: {
				"illLow/a.png": "1",
				"illBlur/a.png": "1",
				"chap/c.png": "3",
			},
			live: ["illLow/a.png", "chap/c.png"],
			trees: { SP: "t1", illLow: "t2" },
		},
		sp,
		["SP", "chap"],
	);
	assert.deepEqual(
		state.queue.map((f) => f.path),
		["SP/b.png"],
	);
	assert.deepEqual(state.manifest, { "chap/c.png": "3" });
	assert.deepEqual(state.live, ["chap/c.png"]);
	assert.deepEqual(state.trees, { SP: "t1" });
	assert.equal(illStateBody(state).pending, 1);
});

test("garbage state parses to an empty state", () => {
	for (const raw of [undefined, null, 3, "x", []]) {
		const state = parseInfoState(raw, () => true);
		assert.deepEqual(state.queue, []);
		assert.deepEqual(state.manifest, {});
	}
	const bad = parseInfoState(
		{ queue: [{ path: 1 }, null, { path: "a", sha: "b" }], manifest: { a: 1 } },
		() => true,
	);
	assert.deepEqual(bad.queue, [{ path: "a", sha: "b", size: 0 }]);
	assert.deepEqual(bad.manifest, {});
});

test("stableKey ignores heartbeat fields only", () => {
	const a = {
		commit: "c",
		updatedAt: "t1",
		lastRun: { ms: 1 },
		aliasesCheckedAt: "x",
	};
	const b = {
		commit: "c",
		updatedAt: "t2",
		lastRun: { ms: 9 },
		aliasesCheckedAt: "y",
	};
	assert.equal(stableKey(a), stableKey(b));
	assert.notEqual(stableKey(a), stableKey({ ...b, commit: "d" }));
});

test("saveIfChanged skips the PUT when only heartbeat fields moved (P9)", async () => {
	const bucket = new FakeBucket();
	const state = parseInfoState({}, () => true);
	state.commit = "c";
	const body = () => infoStateBody(state);
	assert.equal(
		await saveIfChanged(
			bucket,
			"_sync/info.json",
			state,
			body,
			undefined,
			new Date(1000),
		),
		true,
	);
	const first = bucket.objects.get("_sync/info.json");
	assert.equal(first?.options?.httpMetadata?.cacheControl, "no-cache");

	const loaded = await loadRaw(bucket, "_sync/info.json");
	const next = parseInfoState(loaded.raw, () => true);
	next.lastRun = { copied: 0, skipped: 0, failed: 0, remaining: 0, ms: 5 };
	next.aliasesCheckedAt = new Date(2000).toISOString();
	const puts = bucket.count("put");
	assert.equal(
		await saveIfChanged(
			bucket,
			"_sync/info.json",
			next,
			() => infoStateBody(next),
			loaded.baseline,
		),
		false,
	);
	assert.equal(bucket.count("put"), puts);

	next.levelsSha = "new";
	assert.equal(
		await saveIfChanged(
			bucket,
			"_sync/info.json",
			next,
			() => infoStateBody(next),
			loaded.baseline,
		),
		true,
	);
	assert.equal(bucket.json("_sync/info.json").levelsSha, "new");
});

test("listing backoff doubles per failure, is capped, and leaves room for the next cron", () => {
	const state = parseIllState({}, () => true, []);
	const now = Date.parse("2026-01-01T00:00:00Z");
	listFailed(state, now);
	assert.equal(state.listFailures, 1);
	// 15 min minus 1 min of slack: the next */15 cron still runs
	assert.equal(listBlocked(state, now + 14 * 60_000 - 1), true);
	assert.equal(listBlocked(state, now + 15 * 60_000), false);
	listFailed(state, now);
	assert.equal(listBlocked(state, now + 15 * 60_000), true);
	for (let i = 0; i < 10; i++) listFailed(state, now);
	assert.equal(
		state.nextListAt,
		new Date(now + 6 * 60 * 60_000 - 60_000).toISOString(),
	);
	listOk(state);
	assert.equal(listBlocked(state, now), false);
	assert.equal(state.listFailures, undefined);
});
