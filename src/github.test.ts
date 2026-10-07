import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchRaw,
	headCommit,
	listRootTrees,
	listSubtree,
	RawError,
	rawUrl,
	readPhigrosVersion,
} from "./github.ts";
import { FakeBucket, json, stubFetch, testEnv } from "./test-fakes.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("headCommit tries git refs, then the Atom feed, then REST", async () => {
	const env = testEnv(new FakeBucket());
	let stub = stubFetch((url) =>
		url.endsWith("/info/refs?service=git-upload-pack")
			? new Response(
					`001e# service\n${A} refs/heads/mainline\n${B} refs/heads/main\n`,
				)
			: undefined,
	);
	try {
		assert.equal(await headCommit(env, "o/r", "main"), B);
		assert.ok(stub.calls[0]?.init?.signal, "every GitHub call has a timeout");
	} finally {
		stub.restore();
	}
	stub = stubFetch((url) =>
		url.endsWith(".atom")
			? new Response(`<id>tag:github.com,2008:Grit::Commit/${C}</id>`)
			: undefined,
	);
	try {
		assert.equal(await headCommit(env, "o/r", "main"), C);
		assert.equal(stub.count("api.github.com"), 0);
	} finally {
		stub.restore();
	}
	stub = stubFetch((url) =>
		url.includes("api.github.com/repos/o/r/commits/main")
			? json({ sha: A.toUpperCase() })
			: undefined,
	);
	try {
		assert.equal(await headCommit(env, "o/r", "main"), A);
	} finally {
		stub.restore();
	}
	stub = stubFetch(() => new Response("rate limited", { status: 403 }));
	try {
		await assert.rejects(headCommit(env, "o/r", "main"), /GitHub 403/);
	} finally {
		stub.restore();
	}
});

test("listRootTrees keeps the requested dirs; listSubtree prefixes paths and refuses truncated trees", async () => {
	const env = testEnv(new FakeBucket(), { GITHUB_TOKEN: "tok" });
	const stub = stubFetch((url) => {
		if (url.endsWith(`/git/trees/${A}`)) {
			return json({
				tree: [
					{ path: "SP", type: "tree", sha: "t1" },
					{ path: "ill", type: "tree", sha: "t2" },
					{ path: "chap", type: "blob", sha: "t3" },
				],
			});
		}
		if (url.endsWith("/git/trees/t1?recursive=1")) {
			return json({
				tree: [
					{ path: "a.png", type: "blob", sha: "s1", size: 4 },
					{ path: "sub", type: "tree", sha: "t9" },
					{ path: "sub/b.png", type: "blob", sha: "s2" },
				],
			});
		}
		if (url.endsWith("/git/trees/big?recursive=1"))
			return json({ truncated: true, tree: [] });
		return undefined;
	});
	try {
		const roots = await listRootTrees(env, A, ["SP", "chap"]);
		assert.deepEqual([...roots], [["SP", "t1"]]);
		assert.equal(
			new Headers(stub.calls[0]?.init?.headers).get("authorization"),
			"Bearer tok",
		);
		assert.deepEqual(await listSubtree(env, "SP", "t1"), [
			{ path: "SP/a.png", sha: "s1", size: 4 },
			{ path: "SP/sub/b.png", sha: "s2", size: 0 },
		]);
		await assert.rejects(listSubtree(env, "SP", "big"), /truncated/);
	} finally {
		stub.restore();
	}
});

test("fetchRaw encodes paths and reports the status", async () => {
	assert.equal(
		rawUrl("o/r", A, "resources/html/otherimg/a b#.png"),
		`https://raw.githubusercontent.com/o/r/${A}/resources/html/otherimg/a%20b%23.png`,
	);
	const stub = stubFetch((url) =>
		url.endsWith("/ok.png")
			? new Response("png")
			: new Response("no", { status: 404 }),
	);
	try {
		assert.equal(
			new TextDecoder().decode(await fetchRaw("o/r", A, "ok.png")),
			"png",
		);
		await assert.rejects(
			fetchRaw("o/r", A, "missing.png"),
			(err: unknown) => err instanceof RawError && err.status === 404,
		);
	} finally {
		stub.restore();
	}
});

test("readPhigrosVersion finds the newest oldInfo dir, probing in parallel", async () => {
	const stub = stubFetch((url) => {
		const n = Number(url.match(/oldInfo\/(\d+)\//)?.[1]);
		if (n >= 140 && n <= 146 && n !== 143)
			return json({ version_label: `3.${n}` });
		return new Response("", { status: 404 });
	});
	try {
		assert.deepEqual(await readPhigrosVersion("o/r", A, 140), {
			phigros: "3.146",
			phigrosVerNum: 146,
		});
		assert.ok(stub.calls.length <= 18, `${stub.calls.length} probes`);
	} finally {
		stub.restore();
	}
	const none = stubFetch(() => new Response("", { status: 404 }));
	try {
		assert.equal(await readPhigrosVersion("o/r", A, 140), undefined);
	} finally {
		none.restore();
	}
});
