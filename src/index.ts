/**
 * Mirror Catrong/phi-plugin-ill to R2 
 */

const STATE_KEY = "_sync/ills.json"
const TIME_BUDGET_MS = 25_000
const CONCURRENCY = 4
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])

type R2Bucket = {
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>
  delete(keys: string | string[]): Promise<void>
  list(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
}

type Env = {
  ILLS: R2Bucket
  ILL_REPO: string
  ILL_REF: string
  ILL_PREFIX: string
  ILL_DIRS: string
  GITHUB_TOKEN?: string
  SYNC_SECRET?: string
}

type FileEnt = { path: string; sha: string; size: number }

type State = {
  commit?: string
  target?: string
  manifest: Record<string, string>
  pending: FileEnt[]
  live: string[]
  updatedAt?: string
  lastError?: string
  lastRun?: {
    copied: number
    skipped: number
    failed: number
    remaining: number
    ms: number
    commit?: string
  }
}

type TreeEntry = { path: string; type: string; sha: string; size?: number }

function dirsOf(env: Env): string[] {
  return env.ILL_DIRS.split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function prefixOf(env: Env): string {
  return env.ILL_PREFIX.replace(/\/+$/, "")
}

function r2Key(env: Env, rel: string): string {
  const p = prefixOf(env)
  return p ? `${p}/${rel}` : rel
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".")
  return i < 0 ? "" : path.slice(i).toLowerCase()
}

function mimeOf(path: string): string {
  switch (extOf(path)) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    default:
      return "image/png"
  }
}

function wanted(env: Env, path: string): boolean {
  if (!IMAGE_EXT.has(extOf(path))) return false
  const top = path.split("/")[0]
  return dirsOf(env).includes(top || "")
}

async function gh(env: Env, url: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "phi-ill-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GitHub ${res.status} ${url} ${text}`.slice(0, 400))
  }
  return res
}

async function headCommit(env: Env): Promise<string> {
  const res = await gh(env, `https://api.github.com/repos/${env.ILL_REPO}/commits/${encodeURIComponent(env.ILL_REF)}`)
  const body = (await res.json()) as { sha?: string }
  if (!body.sha) throw new Error("GitHub commit sha missing")
  return body.sha
}

async function listTree(env: Env, commit: string): Promise<FileEnt[]> {
  const res = await gh(env, `https://api.github.com/repos/${env.ILL_REPO}/git/trees/${commit}?recursive=1`)
  const body = (await res.json()) as { truncated?: boolean; tree?: TreeEntry[] }
  if (body.truncated) throw new Error("GitHub tree truncated")
  const out: FileEnt[] = []
  for (const ent of body.tree || []) {
    if (ent.type !== "blob" || !wanted(env, ent.path)) continue
    out.push({ path: ent.path, sha: ent.sha, size: ent.size || 0 })
  }
  return out
}

async function loadState(env: Env): Promise<State> {
  const obj = await env.ILLS.get(STATE_KEY)
  if (!obj) return { manifest: {}, pending: [], live: [] }
  try {
    const parsed = JSON.parse(await obj.text()) as State
    return {
      commit: parsed.commit,
      target: parsed.target,
      manifest: parsed.manifest && typeof parsed.manifest === "object" ? parsed.manifest : {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      live: Array.isArray(parsed.live) ? parsed.live : [],
      updatedAt: parsed.updatedAt,
      lastError: parsed.lastError,
      lastRun: parsed.lastRun,
    }
  } catch {
    return { manifest: {}, pending: [], live: [] }
  }
}

async function saveState(env: Env, state: State): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await env.ILLS.put(STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  })
}

async function refreshQueue(env: Env, state: State): Promise<string> {
  const commit = await headCommit(env)
  if (state.target === commit && state.pending.length) return commit
  if (state.commit === commit && !state.pending.length) return commit
  const files = await listTree(env, commit)
  state.target = commit
  state.live = files.map(f => f.path)
  state.pending = files.filter(file => state.manifest[file.path] !== file.sha)
  if (!state.pending.length) state.commit = commit
  return commit
}

async function putOne(env: Env, commit: string, file: FileEnt): Promise<"copied" | "skipped"> {
  const key = r2Key(env, file.path)
  const existing = await env.ILLS.head(key)
  if (existing?.customMetadata?.gitSha === file.sha) return "skipped"
  const raw = `https://raw.githubusercontent.com/${env.ILL_REPO}/${commit}/${file.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`
  const res = await fetch(raw, { headers: { "User-Agent": "phi-ill-sync" } })
  if (!res.ok) throw new Error(`raw ${res.status} ${file.path}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  await env.ILLS.put(key, buf, {
    httpMetadata: { contentType: mimeOf(file.path) },
    customMetadata: { gitSha: file.sha },
  })
  return "copied"
}

async function dropStale(env: Env, keep: Set<string>): Promise<number> {
  const prefix = `${prefixOf(env)}/`
  let cursor: string | undefined
  const stale: string[] = []
  for (;;) {
    const page = await env.ILLS.list({ prefix, cursor, limit: 1000 })
    for (const obj of page.objects) {
      const rel = obj.key.slice(prefix.length)
      const top = rel.split("/")[0]
      if (!dirsOf(env).includes(top || "")) continue
      if (!keep.has(rel)) stale.push(obj.key)
    }
    if (!page.truncated) break
    cursor = page.cursor
    if (!cursor) break
  }
  for (let i = 0; i < stale.length; i += 100) {
    await env.ILLS.delete(stale.slice(i, i + 100))
  }
  return stale.length
}

async function copyBatch(env: Env, commit: string, state: State): Promise<State["lastRun"]> {
  const started = Date.now()
  let copied = 0
  let skipped = 0
  let failed = 0
  const leftover: FileEnt[] = []
  const queue = state.pending.slice()
  state.pending = []

  const run = async (file: FileEnt) => {
    try {
      const kind = await putOne(env, commit, file)
      if (kind === "copied") copied += 1
      else skipped += 1
      state.manifest[file.path] = file.sha
    } catch (err) {
      failed += 1
      leftover.push(file)
      state.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  while (queue.length && Date.now() - started < TIME_BUDGET_MS) {
    const slice = queue.splice(0, CONCURRENCY)
    await Promise.all(slice.map(run))
  }
  leftover.push(...queue)
  state.pending = leftover
  if (!state.pending.length) {
    state.commit = commit
    state.lastError = undefined
    if (state.live.length) {
      const keep = new Set(state.live)
      for (const path of Object.keys(state.manifest)) {
        if (!keep.has(path)) delete state.manifest[path]
      }
      await dropStale(env, keep)
    }
  }
  return {
    copied,
    skipped,
    failed,
    remaining: state.pending.length,
    ms: Date.now() - started,
    commit,
  }
}

export async function syncIlls(env: Env): Promise<State> {
  const state = await loadState(env)
  const commit = await refreshQueue(env, state)
  if (state.pending.length) state.lastRun = await copyBatch(env, commit, state)
  else {
    state.lastRun = {
      copied: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      ms: 0,
      commit,
    }
  }
  await saveState(env, state)
  return state
}

function publicState(state: State) {
  return {
    commit: state.commit,
    pending: state.pending.length,
    files: Object.keys(state.manifest).length,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    lastRun: state.lastRun,
  }
}

function authorized(req: Request, env: Env): boolean {
  const secret = env.SYNC_SECRET?.trim()
  if (!secret) return false
  const hdr = req.headers.get("authorization") || ""
  return hdr === `Bearer ${secret}`
}

export default {
  async scheduled(_controller: { cron: string }, env: Env) {
    const state = await syncIlls(env)
    console.log("ill-sync", JSON.stringify(publicState(state)))
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) return new Response("not found", { status: 404 })
    const url = new URL(req.url)
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json(publicState(await loadState(env)))
    }
    if ((req.method === "POST" || req.method === "GET") && url.pathname === "/sync") {
      return Response.json(publicState(await syncIlls(env)))
    }
    return new Response("not found", { status: 404 })
  },
}
