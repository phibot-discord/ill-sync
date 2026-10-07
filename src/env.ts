export type R2Head = {
	key?: string;
	size: number;
	etag?: string;
	customMetadata?: Record<string, string>;
};

export type R2Body = R2Head & {
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
};

export type R2PutOptions = {
	httpMetadata?: { contentType?: string; cacheControl?: string };
	customMetadata?: Record<string, string>;
};

export type R2Bucket = {
	get(key: string): Promise<R2Body | null>;
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: R2PutOptions,
	): Promise<unknown>;
	head(key: string): Promise<R2Head | null>;
	delete(keys: string | string[]): Promise<void>;
	list(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<{
		objects: { key: string; etag?: string; size?: number }[];
		truncated: boolean;
		cursor?: string;
	}>;
};

export type Env = {
	ILLS: R2Bucket;
	ILL_REPO: string;
	ILL_REF: string;
	ILL_PREFIX: string;
	ILL_DIRS: string;
	INFO_REPO?: string;
	INFO_REF?: string;
	INFO_PREFIX?: string;
	INFO_FILES?: string;
	HTML_PREFIX?: string;
	HTML_DIRS?: string;
	HTML_FILES?: string;
	TAGTREE_URL?: string;
	ALIAS_EXPORT_URL?: string;
	CHART_TAG_API?: string;
	GITHUB_TOKEN?: string;
	SYNC_SECRET?: string;
	PROXY_SECRET?: string;
	UNPACK_URL?: string;
	UNPACK_SECRET?: string;
};

export type FileEnt = { path: string; sha: string; size: number };

export const IMAGE_CACHE =
	"public, max-age=86400, stale-while-revalidate=604800";
export const NO_CACHE = "no-cache";

export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function sha256Hex(
	data: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
