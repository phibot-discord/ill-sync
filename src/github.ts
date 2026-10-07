import type { Env, FileEnt } from "./env.ts";

export const GITHUB_TIMEOUT_MS = 20_000;
const UA = "phi-ill-sync";

type TreeEntry = { path: string; type: string; sha: string; size?: number };

async function gh(env: Env, url: string): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": UA,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	const res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`GitHub ${res.status} ${url} ${text}`.slice(0, 400));
	}
	return res;
}

function sha40(raw: string | undefined): string | undefined {
	return raw && /^[a-f0-9]{40}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

async function headCommitGit(
	repo: string,
	ref: string,
): Promise<string | undefined> {
	const res = await fetch(
		`https://github.com/${repo}.git/info/refs?service=git-upload-pack`,
		{
			headers: { "User-Agent": "git/2.43.0 phi-ill-sync" },
			signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
		},
	);
	if (!res.ok) return undefined;
	const text = await res.text();
	const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.match(
		new RegExp(`([a-f0-9]{40}) refs/heads/${escaped}(?=\\s|$)`),
	);
	return sha40(match?.[1]);
}

async function headCommitAtom(
	repo: string,
	ref: string,
): Promise<string | undefined> {
	const res = await fetch(
		`https://github.com/${repo}/commits/${encodeURIComponent(ref)}.atom`,
		{
			headers: { "User-Agent": UA },
			signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
		},
	);
	if (!res.ok) return undefined;
	const text = await res.text();
	return sha40(text.match(/Commit\/([a-f0-9]{40})/)?.[1]);
}

export async function headCommit(
	env: Env,
	repo: string,
	ref: string,
): Promise<string> {
	const git = await headCommitGit(repo, ref).catch(() => undefined);
	if (git) return git;
	const atom = await headCommitAtom(repo, ref).catch(() => undefined);
	if (atom) return atom;
	const res = await gh(
		env,
		`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
	);
	const body = (await res.json()) as { sha?: string };
	const sha = sha40(body.sha);
	if (!sha) throw new Error("GitHub commit sha missing");
	return sha;
}

export async function listRootTrees(
	env: Env,
	commit: string,
	dirs: string[],
): Promise<Map<string, string>> {
	const res = await gh(
		env,
		`https://api.github.com/repos/${env.ILL_REPO}/git/trees/${commit}`,
	);
	const body = (await res.json()) as { tree?: TreeEntry[] };
	const out = new Map<string, string>();
	for (const ent of body.tree || []) {
		if (ent.type === "tree" && dirs.includes(ent.path))
			out.set(ent.path, ent.sha);
	}
	return out;
}

export async function listSubtree(
	env: Env,
	dir: string,
	treeSha: string,
): Promise<FileEnt[]> {
	const res = await gh(
		env,
		`https://api.github.com/repos/${env.ILL_REPO}/git/trees/${treeSha}?recursive=1`,
	);
	const body = (await res.json()) as {
		truncated?: boolean;
		tree?: TreeEntry[];
	};
	if (body.truncated) throw new Error(`GitHub tree ${dir} truncated`);
	const out: FileEnt[] = [];
	for (const ent of body.tree || []) {
		if (ent.type !== "blob") continue;
		out.push({ path: `${dir}/${ent.path}`, sha: ent.sha, size: ent.size || 0 });
	}
	return out;
}

export async function listContents(
	env: Env,
	repo: string,
	commit: string,
	dir: string,
): Promise<{ name: string; sha: string; size: number }[]> {
	const path = dir.split("/").map(encodeURIComponent).join("/");
	const res = await gh(
		env,
		`https://api.github.com/repos/${repo}/contents/resources/html/${path}?ref=${commit}`,
	);
	const body = (await res.json()) as {
		name: string;
		sha: string;
		size?: number;
		type: string;
	}[];
	if (!Array.isArray(body))
		throw new Error(`GitHub contents ${dir} is not a directory`);
	return body
		.filter((ent) => ent.type === "file")
		.map((ent) => ({ name: ent.name, sha: ent.sha, size: ent.size || 0 }));
}

export function rawUrl(repo: string, commit: string, relPath: string): string {
	return `https://raw.githubusercontent.com/${repo}/${commit}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

export class RawError extends Error {
	status: number;
	constructor(status: number, relPath: string) {
		super(`raw ${status} ${relPath}`);
		this.status = status;
	}
}

export async function fetchRaw(
	repo: string,
	commit: string,
	relPath: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const res = await fetch(rawUrl(repo, commit, relPath), {
		headers: { "User-Agent": UA },
		signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
	});
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new RawError(res.status, relPath);
	}
	return new Uint8Array(await res.arrayBuffer());
}

export async function readPhigrosVersion(
	repo: string,
	commit: string,
	from = 140,
): Promise<{ phigros: string; phigrosVerNum: number } | undefined> {
	const probe = async (n: number) => {
		try {
			const res = await fetch(
				rawUrl(repo, commit, `resources/info/oldInfo/${n}/info.json`),
				{
					headers: { "User-Agent": UA },
					signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
				},
			);
			if (!res.ok) return undefined;
			const json = (await res.json()) as { version_label?: string };
			return { phigros: json.version_label || String(n), phigrosVerNum: n };
		} catch {
			return undefined;
		}
	};
	let last: { phigros: string; phigrosVerNum: number } | undefined;
	let misses = 0;
	const start = Math.max(1, from);
	for (let n = start; n < start + 80 && misses < 5; n += 6) {
		const hits = await Promise.all(
			Array.from({ length: Math.min(6, start + 80 - n) }, (_, i) =>
				probe(n + i),
			),
		);
		for (const hit of hits) {
			if (misses >= 5) break;
			if (!hit) {
				misses += 1;
				continue;
			}
			misses = 0;
			last = hit;
		}
	}
	return last;
}
