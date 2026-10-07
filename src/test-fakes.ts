import type { Env, R2Body, R2Bucket, R2PutOptions } from "./env.ts";

type Stored = { bytes: Uint8Array; etag: string; options?: R2PutOptions };

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof value === "string") return new TextEncoder().encode(value);
	return value instanceof Uint8Array
		? value.slice()
		: new Uint8Array(value.slice(0));
}

function etagOf(bytes: Uint8Array): string {
	let h = 0x811c9dc5;
	for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
	return `${h.toString(16).padStart(8, "0")}${bytes.length.toString(16)}`;
}

export class FakeBucket implements R2Bucket {
	objects = new Map<string, Stored>();
	ops: string[] = [];

	seed(
		key: string,
		value: string | Uint8Array,
		customMetadata?: Record<string, string>,
	) {
		const bytes = toBytes(value);
		this.objects.set(key, {
			bytes,
			etag: etagOf(bytes),
			options: { customMetadata },
		});
	}

	text(key: string): string | undefined {
		const obj = this.objects.get(key);
		return obj && new TextDecoder().decode(obj.bytes);
	}

	json(key: string): Record<string, unknown> {
		return JSON.parse(this.text(key) ?? "null") as Record<string, unknown>;
	}

	count(op: string): number {
		return this.ops.filter(
			(entry) => entry === op || entry.startsWith(`${op} `),
		).length;
	}

	async get(key: string): Promise<R2Body | null> {
		this.ops.push(`get ${key}`);
		const obj = this.objects.get(key);
		if (!obj) return null;
		const bytes = obj.bytes;
		return {
			key,
			size: bytes.length,
			etag: obj.etag,
			customMetadata: obj.options?.customMetadata,
			text: async () => new TextDecoder().decode(bytes),
			arrayBuffer: async () => bytes.slice().buffer,
		};
	}

	async put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: R2PutOptions,
	) {
		this.ops.push(`put ${key}`);
		const bytes = toBytes(value);
		this.objects.set(key, { bytes, etag: etagOf(bytes), options });
		return {};
	}

	async head(key: string) {
		this.ops.push(`head ${key}`);
		const obj = this.objects.get(key);
		if (!obj) return null;
		return {
			key,
			size: obj.bytes.length,
			etag: obj.etag,
			customMetadata: obj.options?.customMetadata,
		};
	}

	async delete(keys: string | string[]) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.ops.push(`delete ${key}`);
			this.objects.delete(key);
		}
	}

	async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
		const prefix = opts.prefix ?? "";
		this.ops.push(`list ${prefix}`);
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(prefix))
			.sort();
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? 1000;
		const page = keys.slice(start, start + limit);
		const truncated = start + limit < keys.length;
		return {
			objects: page.map((key) => {
				const obj = this.objects.get(key) as Stored;
				return { key, etag: obj.etag, size: obj.bytes.length };
			}),
			truncated,
			cursor: truncated ? String(start + limit) : undefined,
		};
	}
}

export function testEnv(bucket: FakeBucket, extra: Partial<Env> = {}): Env {
	return {
		ILLS: bucket,
		ILL_REPO: "o/ill",
		ILL_REF: "main",
		ILL_PREFIX: "original_ill",
		ILL_DIRS: "SP,chap",
		INFO_REPO: "o/plugin",
		INFO_REF: "main",
		INFO_PREFIX: "info",
		INFO_FILES: "chaplist.yaml,nicklist.yaml",
		HTML_PREFIX: "html",
		HTML_DIRS: "",
		HTML_FILES: "otherimg/A.png,otherimg/B.png",
		TAGTREE_URL: "https://phib19.test/chartsTag/get/tagTree",
		ALIAS_EXPORT_URL:
			"https://phib19.test/alias-proposals/export/nicklist.json",
		...extra,
	};
}

export type Route = (
	url: string,
	init: RequestInit | undefined,
) => Response | Promise<Response> | undefined;

/** Replace global fetch; the first route that returns a Response wins, anything else is a network error */
export function stubFetch(...routes: Route[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		calls.push({ url, init });
		for (const route of routes) {
			const res = await route(url, init);
			if (res) return res;
		}
		throw new TypeError(`fetch failed: ${url}`);
	}) as typeof fetch;
	return {
		calls,
		count: (part: string) =>
			calls.filter((call) => call.url.includes(part)).length,
		restore: () => {
			globalThis.fetch = real;
		},
	};
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init.headers as Record<string, string>),
		},
	});
}
