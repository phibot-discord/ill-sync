import assert from "node:assert/strict";
import test from "node:test";
import type { FileEnt } from "./env.ts";
import { RawError } from "./github.ts";
import { parseIllState } from "./state.ts";
import { drain, dropStale, syncIlls, syncInfo, syncLevels } from "./sync.ts";
import { FakeBucket, json, stubFetch, testEnv } from "./test-fakes.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const T0 = Date.parse("2026-10-06T00:00:00Z");
const CSV =
	"id\tsong\tcomposer\tillustrator\tEZC\tHDC\tINC\tATC\tEZ\tHD\tIN\tAT\na\tA\tc\ti\t\t\t\t\t1\t6.5\t12.6\t\nb\tB\tc\ti\t\t\t\t\t2\t7\t13\t15.8\n";

/** Upstreams the Worker talks to: GitHub (git refs, REST, raw) and phib19 (tagTree, alias export) */
class World {
	down = false;
	/** Only the REST contents listing (otherimg) fails, as when the shared 60/h limit is used up */
	contentsDown = false;
	illHead = sha(1);
	infoHead = sha(2);
	/** dir -> tree sha and files (name -> blob sha) of phi-plugin-ill at `illHead` */
	illDirs: Record<string, { tree: string; files: Record<string, string> }> = {
		SP: { tree: "tSP1", files: { "a.png": "bA", "b.png": "bB" } },
		chap: { tree: "tchap1", files: { "c1.png": "bC" } },
		ill: { tree: "till1", files: { "x.png": "bX" } },
	};
	info: Record<string, string> = {
		"chaplist.yaml": "chap: 1\n",
		"nicklist.yaml": "a: [x]\n",
	};
	otherimg: Record<string, string> = {
		"A.png": "gA",
		"B.png": "gB",
		"C.png": "gC",
	};
	version = 141;
	tagTree = '{"data":[{"name":"t"}]}';
	aliases: Record<string, string[]> = { a: ["x"], b: ["y", "z"] };
	aliasEtag = 'W/"1"';

	route = (
		url: string,
		init: RequestInit | undefined,
	): Response | undefined => {
		const u = new URL(url);
		if (u.hostname === "phib19.test") {
			if (u.pathname.endsWith("/tagTree"))
				return json(JSON.parse(this.tagTree));
			if (new Headers(init?.headers).get("if-none-match") === this.aliasEtag) {
				return new Response(null, {
					status: 304,
					headers: { etag: this.aliasEtag },
				});
			}
			return json(this.aliases, { headers: { etag: this.aliasEtag } });
		}
		if (this.down) return new Response("unavailable", { status: 503 });
		if (u.hostname === "github.com") {
			const head = url.includes("/o/ill.git/") ? this.illHead : this.infoHead;
			return new Response(
				`001e# service=git-upload-pack\n${head} refs/heads/main\n`,
			);
		}
		if (u.hostname === "api.github.com") {
			const trees = u.pathname.match(/^\/repos\/o\/ill\/git\/trees\/(.+)$/);
			if (trees && !u.search) {
				return json({
					tree: Object.entries(this.illDirs).map(([path, dir]) => ({
						path,
						type: "tree",
						sha: dir.tree,
					})),
				});
			}
			if (trees) {
				const dir = Object.values(this.illDirs).find(
					(d) => d.tree === trees[1],
				);
				if (!dir) return new Response("missing", { status: 404 });
				const tree = Object.entries(dir.files).map(([path, blob]) => ({
					path,
					type: "blob",
					sha: blob,
					size: 1,
				}));
				return json({
					tree: [
						...tree,
						{ path: "notes.txt", type: "blob", sha: "n", size: 1 },
					],
				});
			}
			if (u.pathname === "/repos/o/plugin/contents/resources/html/otherimg") {
				if (this.contentsDown)
					return new Response("rate limited", { status: 403 });
				return json(
					Object.entries(this.otherimg).map(([name, blob]) => ({
						name,
						sha: blob,
						size: 1,
						type: "file",
					})),
				);
			}
		}
		if (u.hostname === "raw.githubusercontent.com") {
			const [, , repo, , ...rest] = u.pathname.split("/");
			const path = rest.map(decodeURIComponent).join("/");
			const version = path.match(
				/^resources\/info\/oldInfo\/(\d+)\/info\.json$/,
			);
			if (version) {
				const n = Number(version[1]);
				return n <= this.version
					? json({ version_label: `3.${n}` })
					: new Response("404", { status: 404 });
			}
			if (repo === "plugin" && path.startsWith("resources/info/")) {
				const text = this.info[path.slice("resources/info/".length)];
				return text === undefined
					? new Response("404", { status: 404 })
					: new Response(text);
			}
			if (repo === "plugin" && path.startsWith("resources/html/otherimg/")) {
				const blob =
					this.otherimg[path.slice("resources/html/otherimg/".length)];
				return blob
					? new Response(`png:${blob}`)
					: new Response("404", { status: 404 });
			}
			if (repo === "ill") {
				const [dir, name] = path.split("/");
				const blob = this.illDirs[dir ?? ""]?.files[name ?? ""];
				return blob
					? new Response(`png:${blob}`)
					: new Response("404", { status: 404 });
			}
		}
		return undefined;
	};
}

function setup() {
	const world = new World();
	const bucket = new FakeBucket();

	bucket.seed("info/info.csv", CSV);
	bucket.seed("info/notesInfo.json", "{}");
	bucket.seed("info/tips.txt", "tip\n");
	bucket.seed("info/avatar.txt", "Introduction\n");
	bucket.seed("original_ill/ill/x.png", "apk");
	bucket.seed("original_ill/illLow/x.png", "apk");
	bucket.seed("html/avatar/Introduction.png", "apk");
	bucket.seed("web-cards/u.jpg", "card");
	const fetches = stubFetch(world.route);
	const env = testEnv(bucket);
	return { world, bucket, env, fetches };
}

const APK_KEYS = [
	"info/info.csv",
	"info/notesInfo.json",
	"info/tips.txt",
	"info/avatar.txt",
	"original_ill/ill/x.png",
	"original_ill/illLow/x.png",
	"html/avatar/Introduction.png",
	"web-cards/u.jpg",
];

function assertApkUntouched(bucket: FakeBucket) {
	for (const key of APK_KEYS) {
		assert.ok(bucket.objects.has(key), `${key} still exists`);
		assert.equal(bucket.count(`put ${key}`), 0, `${key} not written`);
	}
}

test("info: a first run mirrors the files and writes a state consumers read as ready", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const stored = bucket.json("_sync/info.json");
		assert.equal(stored.commit, world.infoHead);
		assert.equal(stored.pending, 0);
		assert.deepEqual(stored.queue, []);
		assert.equal(stored.head, world.infoHead);
		assert.equal(stored.phigros, "3.141");
		assert.equal(stored.phigrosVerNum, 141);
		assert.equal(stored.levelsSongs, 2);
		assert.equal(stored.levelsMax, 15.8);
		assert.match(String(stored.levelsSha), /^[0-9a-f]{64}$/);
		assert.match(String(stored.tagTreeSha), /^[0-9a-f]{64}$/);
		assert.equal(stored.aliasesSha, bucket.json("info/aliases.json").sha);
		assert.equal(stored.aliasesCount, 3);
		assert.equal(stored.lastError, undefined);

		assert.equal(bucket.text("info/chaplist.yaml"), "chap: 1\n");
		assert.equal(bucket.text("info/nicklist.yaml"), "a: [x]\n");
		const yaml = bucket.objects.get("info/nicklist.yaml")?.options;
		assert.equal(yaml?.httpMetadata?.cacheControl, "no-cache");
		assert.match(yaml?.customMetadata?.contentSha ?? "", /^[0-9a-f]{64}$/);
		assert.equal(bucket.text("html/otherimg/A.png"), "png:gA");
		assert.ok(bucket.objects.has("html/otherimg/B.png"));
		assert.ok(!bucket.objects.has("html/otherimg/C.png"));
		const png = bucket.objects.get("html/otherimg/A.png")?.options;
		assert.equal(
			png?.httpMetadata?.cacheControl,
			"public, max-age=86400, stale-while-revalidate=604800",
		);
		assert.equal(png?.customMetadata?.gitSha, "gA");

		assert.ok(
			bucket.ops.indexOf("put info/aliases.json") <
				bucket.ops.indexOf("put _sync/info.json"),
		);
		assertApkUntouched(bucket);
	} finally {
		fetches.restore();
	}
});

test("info: an idle run writes nothing and sends If-None-Match for aliases (P9)", async () => {
	const { bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const puts = bucket.count("put");
		const before = bucket.objects.get("_sync/info.json")?.etag;
		const state = await syncInfo(env, { now: T0 + 15 * 60_000 });
		assert.equal(bucket.count("put"), puts);
		assert.equal(bucket.objects.get("_sync/info.json")?.etag, before);
		assert.equal(
			fetches.count("api.github.com"),
			1,
			"contents listed once, on the first run",
		);
		const alias = fetches.calls.filter((call) =>
			call.url.includes("nicklist.json"),
		);
		assert.equal(
			new Headers(alias[1]?.init?.headers).get("if-none-match"),
			'W/"1"',
		);
		assert.equal(state.aliasesError, undefined);
	} finally {
		fetches.restore();
	}
});

test("info: a code-only commit uploads nothing and keeps commit; a content change moves it (P5)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const first = world.infoHead;
		const puts = bucket.count("put info/");
		world.infoHead = sha(3);
		await syncInfo(env, { now: T0 + 1 });
		let stored = bucket.json("_sync/info.json");
		assert.equal(bucket.count("put info/"), puts);
		assert.equal(stored.commit, first, "consumers do not reload");
		assert.equal(stored.head, world.infoHead);
		assert.equal(stored.pending, 0);

		world.infoHead = sha(4);
		world.info["nicklist.yaml"] = "a: [x, y]\n";
		await syncInfo(env, { now: T0 + 2 });
		stored = bucket.json("_sync/info.json");
		assert.equal(bucket.count("put info/nicklist.yaml"), 2);
		assert.equal(bucket.count("put info/chaplist.yaml"), 1);
		assert.equal(stored.commit, world.infoHead);
		assert.equal(bucket.text("info/nicklist.yaml"), "a: [x, y]\n");
	} finally {
		fetches.restore();
	}
});

test("info: an otherimg-only change is mirrored but does not move commit", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const first = world.infoHead;
		world.infoHead = sha(5);
		world.otherimg["A.png"] = "gA2";
		await syncInfo(env, { now: T0 + 1 });
		const stored = bucket.json("_sync/info.json");
		assert.equal(bucket.text("html/otherimg/A.png"), "png:gA2");
		assert.equal(
			stored.commit,
			first,
			"consumers only reload info/* for info file changes",
		);
		assert.equal(stored.head, world.infoHead);
		assert.equal(stored.changed, undefined);
		assert.equal(stored.pending, 0);
	} finally {
		fetches.restore();
	}
});

test("info: levelsSha follows the etags of phi-unpackd's files (P1)", async () => {
	const { bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const first = bucket.json("_sync/info.json").levelsSha;

		await bucket.put("info/tips.txt", "tip\n");
		await syncInfo(env, { now: T0 + 1 });
		assert.equal(bucket.json("_sync/info.json").levelsSha, first);

		await bucket.put("info/tips.txt", "new tip\n");
		await bucket.put(
			"info/info.csv",
			`${CSV}c\tC\tc\ti\t\t\t\t\t3\t8\t14\t16.1\n`,
		);
		await syncInfo(env, { now: T0 + 2 });
		const stored = bucket.json("_sync/info.json");
		assert.notEqual(stored.levelsSha, first);
		assert.equal(stored.levelsSongs, 3);
		assert.equal(stored.levelsMax, 16.1);
		assert.equal(stored.pending, 0);
	} finally {
		fetches.restore();
	}
});

test("syncLevels: missing APK files are an error and keep the old sha", async () => {
	const bucket = new FakeBucket();
	const state = { levelsSha: "old" } as Parameters<typeof syncLevels>[1];
	await assert.rejects(syncLevels(testEnv(bucket), state), /no APK info files/);
	assert.equal(state.levelsSha, "old");
});

test("info: GitHub down saves the error with a backoff; aliases, levels and tagTree still sync (P7)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		world.down = true;
		let state = await syncInfo(env, { now: T0 });
		let stored = bucket.json("_sync/info.json");
		assert.match(String(stored.lastError), /GitHub 503/);
		assert.equal(stored.listFailures, 1);
		assert.ok(stored.nextListAt);
		assert.equal(stored.pending, 0);
		assert.ok(stored.aliasesSha, "aliases do not wait for GitHub");
		assert.ok(stored.tagTreeSha, "tagTree still runs");
		assert.ok(stored.levelsSha);
		assert.equal(stored.commit, undefined, "not ready: nothing mirrored yet");

		state = await syncInfo(env, { now: T0 + 15 * 60_000 });
		const calls = fetches.calls.length;
		state = await syncInfo(env, { now: T0 + 30 * 60_000 });
		assert.equal(
			fetches.calls
				.slice(calls)
				.filter((call) => !call.url.includes("phib19.test")).length,
			0,
		);
		assert.match(
			String(state.lastError),
			/GitHub 503/,
			"a held-back run keeps the error",
		);

		world.down = false;
		state = await syncInfo(env, { now: T0 + 31 * 60_000, force: true });
		stored = bucket.json("_sync/info.json");
		assert.equal(stored.lastError, undefined);
		assert.equal(stored.nextListAt, undefined);
		assert.equal(stored.commit, world.infoHead);
	} finally {
		fetches.restore();
	}
});

test("info: a failing otherimg listing still mirrors the info files; html is listed again after the backoff", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const first = world.infoHead;
		world.infoHead = sha(6);
		world.info["chaplist.yaml"] = "chap: 2\n";
		world.otherimg["A.png"] = "gA2";
		world.contentsDown = true;
		bucket.seed("html/otherimg/old.png", "x");
		await syncInfo(env, { now: T0 + 1 });
		let stored = bucket.json("_sync/info.json");

		assert.equal(bucket.text("info/chaplist.yaml"), "chap: 2\n");
		assert.equal(stored.commit, world.infoHead);
		assert.equal(stored.pending, 0);
		assert.match(String(stored.lastError), /GitHub 403/);
		assert.ok(stored.nextListAt);

		assert.equal(stored.head, first);
		assert.equal(bucket.text("html/otherimg/A.png"), "png:gA");
		assert.ok(bucket.objects.has("html/otherimg/old.png"));
		assert.ok(bucket.objects.has("html/otherimg/B.png"));

		const calls = fetches.calls.length;
		await syncInfo(env, { now: T0 + 2 });
		assert.equal(
			fetches.calls
				.slice(calls)
				.filter((call) => !call.url.includes("phib19.test")).length,
			0,
		);

		world.contentsDown = false;
		const probes = fetches.count("/oldInfo/");
		await syncInfo(env, { now: T0 + 15 * 60_000 });
		stored = bucket.json("_sync/info.json");
		assert.equal(stored.head, world.infoHead);
		assert.equal(stored.lastError, undefined);
		assert.equal(bucket.text("html/otherimg/A.png"), "png:gA2");
		assert.ok(!bucket.objects.has("html/otherimg/old.png"));
		assert.equal(stored.commit, world.infoHead);
		assert.equal(
			bucket.count("put info/chaplist.yaml"),
			2,
			"unchanged info files are not uploaded again",
		);
		assert.equal(
			fetches.count("/oldInfo/"),
			probes,
			"the version was already probed for this commit",
		);
	} finally {
		fetches.restore();
	}
});

test("info: content R2 already holds still moves commit when the state missed it (lost save)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncInfo(env, { now: T0 });
		const saved = bucket.text("_sync/info.json") as string;
		world.infoHead = sha(7);
		world.info["nicklist.yaml"] = "a: [x, w]\n";
		await syncInfo(env, { now: T0 + 1 });

		bucket.seed("_sync/info.json", saved);
		await syncInfo(env, { now: T0 + 2 });
		const stored = bucket.json("_sync/info.json");
		assert.equal(
			bucket.count("put info/nicklist.yaml"),
			2,
			"R2 already had it",
		);
		assert.equal(stored.commit, world.infoHead);
	} finally {
		fetches.restore();
	}
});

test("info: an old-format state migrates, and APK files queued by an old config are never uploaded (P3)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		bucket.seed(
			"_sync/info.json",
			JSON.stringify({
				commit: world.infoHead,
				target: world.infoHead,
				pending: [
					{ path: "tips.txt", sha: world.infoHead, size: 0 },
					{ path: "html/avatar/Introduction.png", sha: "g", size: 1 },
				],
				manifest: {
					"info.csv": "x",
					"tagTree.json": "y",
					"html/otherimg/A.png": "gA",
				},
				live: ["html/otherimg/A.png", "html/avatar/Introduction.png"],
			}),
		);
		world.info["tips.txt"] = "github tips\n";
		await syncInfo(env, { now: T0 });
		const stored = bucket.json("_sync/info.json");
		assert.equal(stored.pending, 0);
		assert.equal(typeof stored.pending, "number");
		assert.deepEqual(Object.keys(stored.manifest as object).sort(), [
			"chaplist.yaml",
			"html/otherimg/A.png",
			"html/otherimg/B.png",
			"nicklist.yaml",
		]);
		assert.equal(bucket.text("info/tips.txt"), "tip\n");
		assertApkUntouched(bucket);
	} finally {
		fetches.restore();
	}
});

test("info: stale otherimg objects are pruned inside html/otherimg/ only", async () => {
	const { bucket, env, fetches } = setup();
	try {
		bucket.seed("html/otherimg/old.png", "x");
		await syncInfo(env, { now: T0 });
		assert.ok(!bucket.objects.has("html/otherimg/old.png"));
		assert.ok(bucket.objects.has("html/otherimg/A.png"));
		assert.ok(bucket.objects.has("html/avatar/Introduction.png"));
	} finally {
		fetches.restore();
	}
});

test("ills: SP and chap are mirrored with pending as a count; APK dirs are never touched", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		bucket.seed("original_ill/SP/gone.png", "old");
		await syncIlls(env, { now: T0 });
		const stored = bucket.json("_sync/ills.json");
		assert.equal(stored.commit, world.illHead);
		assert.equal(stored.pending, 0);
		assert.deepEqual(stored.trees, { SP: "tSP1", chap: "tchap1" });
		assert.equal(bucket.text("original_ill/SP/a.png"), "png:bA");
		assert.equal(bucket.text("original_ill/chap/c1.png"), "png:bC");
		assert.equal(
			bucket.objects.get("original_ill/SP/a.png")?.options?.httpMetadata
				?.cacheControl,
			"public, max-age=86400, stale-while-revalidate=604800",
		);
		assert.ok(
			!bucket.objects.has("original_ill/SP/gone.png"),
			"stale SP object pruned",
		);
		assert.ok(
			!bucket.objects.has("original_ill/SP/notes.txt"),
			"non-images are skipped",
		);
		assert.equal(
			fetches.count("/git/trees/till1"),
			0,
			"the ill dir is never listed",
		);
		assertApkUntouched(bucket);
	} finally {
		fetches.restore();
	}
});

test("ills: a new commit with unchanged SP/chap trees lists nothing more (P6) and writes once", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncIlls(env, { now: T0 });
		const subtrees = fetches.count("?recursive=1");
		const puts = bucket.count("put original_ill/");
		const lists = bucket.count("list");
		world.illHead = sha(9);
		world.illDirs.ill = { tree: "till2", files: { "y.png": "bY" } };
		await syncIlls(env, { now: T0 + 1 });
		assert.equal(fetches.count("?recursive=1"), subtrees);
		assert.equal(bucket.count("put original_ill/"), puts);
		assert.equal(
			bucket.count("list"),
			lists,
			"nothing relisted, so nothing to prune",
		);
		assert.equal(bucket.json("_sync/ills.json").commit, world.illHead);

		const statePuts = bucket.count("put _sync/ills.json");
		await syncIlls(env, { now: T0 + 2 });
		assert.equal(
			bucket.count("put _sync/ills.json"),
			statePuts,
			"idle run does not rewrite state (P9)",
		);
	} finally {
		fetches.restore();
	}
});

test("ills: a deletions-only commit removes the object, inside its own dir only (P8)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncIlls(env, { now: T0 });
		world.illHead = sha(10);
		world.illDirs.SP = { tree: "tSP2", files: { "a.png": "bA" } };
		await syncIlls(env, { now: T0 + 1 });
		assert.ok(!bucket.objects.has("original_ill/SP/b.png"));
		assert.ok(bucket.objects.has("original_ill/SP/a.png"));
		assert.ok(bucket.objects.has("original_ill/chap/c1.png"));
		assert.equal(
			fetches.count("/git/trees/tchap1?recursive=1"),
			1,
			"chap listed only on the first run",
		);
		const stored = bucket.json("_sync/ills.json");
		assert.equal(
			stored.manifest && "SP/b.png" in (stored.manifest as object),
			false,
		);
		assertApkUntouched(bucket);
	} finally {
		fetches.restore();
	}
});

test("ills: an empty listing for a dir never wipes that dir", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		await syncIlls(env, { now: T0 });
		world.illHead = sha(11);
		world.illDirs.chap = { tree: "tchap2", files: {} };
		await syncIlls(env, { now: T0 + 1 });
		assert.ok(bucket.objects.has("original_ill/chap/c1.png"));
		assert.equal(bucket.json("_sync/ills.json").commit, world.illHead);
	} finally {
		fetches.restore();
	}
});

test("ills: an old state with illLow/illBlur entries is pruned on load and never fetched (P3)", async () => {
	const { world, bucket, env, fetches } = setup();
	try {
		bucket.seed(
			"_sync/ills.json",
			JSON.stringify({
				commit: sha(0),
				target: world.illHead,
				pending: [{ path: "illLow/x.png", sha: "q", size: 1 }],
				manifest: { "illLow/x.png": "q", "illBlur/x.png": "q" },
				live: ["illLow/x.png"],
			}),
		);
		await syncIlls(env, { now: T0 });
		assert.equal(fetches.count("/illLow/"), 0);
		assert.equal(bucket.text("original_ill/illLow/x.png"), "apk");
		const stored = bucket.json("_sync/ills.json");
		assert.equal(stored.pending, 0);
		assert.deepEqual(Object.keys(stored.manifest as object).sort(), [
			"SP/a.png",
			"SP/b.png",
			"chap/c1.png",
		]);
	} finally {
		fetches.restore();
	}
});

test("ills: a failing raw download keeps the file queued, and the error clears once it succeeds", async () => {
	const { world, bucket, env, fetches } = setup();
	const real = world.route;
	let fail = true;
	world.route = (url, init) =>
		fail && url.endsWith("/SP/b.png")
			? new Response("busy", { status: 502 })
			: real(url, init);
	fetches.restore();
	const again = stubFetch((url, init) => world.route(url, init));
	try {
		await syncIlls(env, { now: T0 });
		let stored = bucket.json("_sync/ills.json");
		assert.equal(stored.pending, 1);
		assert.match(String(stored.lastError), /raw 502 SP\/b\.png/);
		assert.equal(stored.commit, undefined, "not finished");
		fail = false;
		await syncIlls(env, { now: T0 + 1 });
		stored = bucket.json("_sync/ills.json");
		assert.equal(stored.pending, 0);
		assert.equal(stored.lastError, undefined);
		assert.equal(stored.commit, world.illHead);
	} finally {
		again.restore();
	}
});

test("drain runs a bounded worker pool, drops upstream 404s and requeues other failures", async () => {
	const state = parseIllState({}, () => true, []);
	state.queue = Array.from(
		{ length: 10 },
		(_, i): FileEnt => ({ path: `SP/${i}.png`, sha: `s${i}`, size: 1 }),
	);
	state.manifest["SP/3.png"] = "old";
	let inFlight = 0;
	let peak = 0;
	const run = await drain(
		state,
		"c",
		async (file) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			if (file.path === "SP/3.png") throw new RawError(404, file.path);
			if (file.path === "SP/4.png") throw new RawError(500, file.path);
			return { copied: file.path !== "SP/5.png", sha: file.sha };
		},
		10_000,
		3,
	);
	assert.equal(peak, 3);
	assert.deepEqual(
		state.queue.map((f) => f.path),
		["SP/4.png"],
	);
	assert.equal(state.manifest["SP/3.png"], undefined);
	assert.equal(state.manifest["SP/0.png"], "s0");
	assert.equal(run.copied, 7);
	assert.equal(run.skipped, 1);
	assert.equal(run.failed, 2);
	assert.equal(run.remaining, 1);
	assert.match(run.error ?? "", /raw (404|500)/);
});

test("drain stops starting files once the budget is spent and keeps the rest queued", async () => {
	const state = parseIllState({}, () => true, []);
	state.queue = Array.from(
		{ length: 5 },
		(_, i): FileEnt => ({ path: `SP/${i}.png`, sha: "s", size: 1 }),
	);
	const run = await drain(
		state,
		"c",
		async (file) => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { copied: true, sha: file.sha };
		},
		10,
		1,
	);
	assert.equal(run.copied, 1);
	assert.equal(state.queue.length, 4);
});

test("dropStale only works inside one owned dir", async () => {
	const bucket = new FakeBucket();
	for (const prefix of [
		"original_ill/",
		"original_ill/ill/",
		"original_ill/illLow/",
		"original_ill/illBlur/",
		"html/",
		"html/avatar/",
		"info/",
		"phira/",
		"web-cards/",
		"_sync/",
		"",
		"original_ill/SP",
	]) {
		await assert.rejects(
			dropStale(bucket, prefix, new Set()),
			/refusing to prune/,
			prefix,
		);
	}
	bucket.seed("original_ill/SP/a.png", "a");
	bucket.seed("original_ill/SP/b.png", "b");
	bucket.seed("original_ill/SPX/c.png", "c");
	assert.equal(
		await dropStale(bucket, "original_ill/SP/", new Set(["a.png"])),
		1,
	);
	assert.deepEqual([...bucket.objects.keys()].sort(), [
		"original_ill/SP/a.png",
		"original_ill/SPX/c.png",
	]);
});
