import { infoFileToCsv, parseInfoFile, summarizeInfoFile } from "./info-file"
import { chartTagProxyUrl, DEFAULT_CHART_TAG_API } from "./chart-tag-proxy"
import { proxyAuthorized } from "./proxy-auth"
import { tapProxyHeaders, tapProxyTarget } from "./tap-proxy"

const STATE_KEY = "_sync/ills.json"
const INFO_STATE_KEY = "_sync/info.json"
const TIME_BUDGET_MS = 25_000
const CONCURRENCY = 4
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
const DEFAULT_INFOFILE_URL = "https://phib19.top:8080/get/infoFile"
const DEFAULT_TAGTREE_URL = "https://phib19.top:8080/chartsTag/get/tagTree"
const DEFAULT_INFO_KV_KEY = "phi:infoFile"
const DEFAULT_INFO_FILES = [
  "avatar.txt",
  "chaplist.yaml",
  "infolist.json",
  "nicklist.yaml",
  "notesInfo.json",
  "spinfo.json",
  "tips.txt",
]
const DEFAULT_HTML_DIRS = ["avatar"]
const DEFAULT_HTML_FILES = [
  "otherimg/0.png",
  "otherimg/1.png",
  "otherimg/2.png",
  "otherimg/3.png",
  "otherimg/4.png",
  "otherimg/5.png",
  "otherimg/A.png",
  "otherimg/B.png",
  "otherimg/C.png",
  "otherimg/F.png",
  "otherimg/FC.png",
  "otherimg/NEW.png",
  "otherimg/S.png",
  "otherimg/V.png",
  "otherimg/phi.png",
  "otherimg/phigros.png",
  "otherimg/data.png",
  "otherimg/Star1.png",
  "otherimg/Star2.png",
]

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

type KVNamespace = {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

type Env = {
  ILLS: R2Bucket
  KV?: KVNamespace
  ILL_REPO: string
  ILL_REF: string
  ILL_PREFIX: string
  ILL_DIRS: string
  INFO_REPO?: string
  INFO_REF?: string
  INFO_PREFIX?: string
  INFO_FILES?: string
  HTML_PREFIX?: string
  HTML_DIRS?: string
  HTML_FILES?: string
  INFOFILE_URL?: string
  TAGTREE_URL?: string
  CHART_TAG_API?: string
  INFO_KV_KEY?: string
  GITHUB_TOKEN?: string
  SYNC_SECRET?: string
  /** `wrangler secret put PROXY_SECRET`; the WebUI sends it as `x-phi-proxy-key`. */
  PROXY_SECRET?: string
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

type InfoState = {
  commit?: string
  target?: string
  manifest: Record<string, string>
  pending: FileEnt[]
  live: string[]
  phigros?: string
  phigrosVerNum?: number
  levelsSha?: string
  levelsSongs?: number
  levelsMax?: number
  levelsError?: string
  tagTreeSha?: string
  tagTreeError?: string
  updatedAt?: string
  lastError?: string
  lastRun?: State["lastRun"]
}

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
    case ".json":
      return "application/json"
    case ".csv":
      return "text/csv"
    case ".yaml":
    case ".yml":
      return "text/yaml"
    case ".txt":
      return "text/plain"
    default:
      return "image/png"
  }
}

function wanted(dirs: Set<string>, path: string): boolean {
  if (!IMAGE_EXT.has(extOf(path))) return false
  return dirs.has(path.split("/")[0] || "")
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

function sha40(raw: string | undefined): string | undefined {
  return raw && /^[a-f0-9]{40}$/i.test(raw) ? raw.toLowerCase() : undefined
}

async function headCommitGit(repo: string, ref: string): Promise<string | undefined> {
  const res = await fetch(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, {
    headers: { "User-Agent": "git/2.43.0 phi-ill-sync" },
  })
  if (!res.ok) return undefined
  const text = await res.text()
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = text.match(new RegExp(`([a-f0-9]{40}) refs/heads/${escaped}(?=\\s|$)`))
  return sha40(match?.[1])
}

async function headCommitAtom(repo: string, ref: string): Promise<string | undefined> {
  const res = await fetch(`https://github.com/${repo}/commits/${encodeURIComponent(ref)}.atom`, {
    headers: { "User-Agent": "phi-ill-sync" },
  })
  if (!res.ok) return undefined
  const text = await res.text()
  return sha40(text.match(/Commit\/([a-f0-9]{40})/)?.[1])
}

async function headCommit(env: Env, repo = env.ILL_REPO, ref = env.ILL_REF): Promise<string> {
  const git = await headCommitGit(repo, ref)
  if (git) return git
  const atom = await headCommitAtom(repo, ref)
  if (atom) return atom
  const res = await gh(env, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)
  const body = (await res.json()) as { sha?: string }
  const sha = sha40(body.sha)
  if (!sha) throw new Error("GitHub commit sha missing")
  return sha
}

async function listTree(env: Env, commit: string): Promise<FileEnt[]> {
  const res = await gh(env, `https://api.github.com/repos/${env.ILL_REPO}/git/trees/${commit}?recursive=1`)
  const body = (await res.json()) as { truncated?: boolean; tree?: TreeEntry[] }
  if (body.truncated) throw new Error("GitHub tree truncated")
  const dirs = new Set(dirsOf(env))
  const out: FileEnt[] = []
  for (const ent of body.tree || []) {
    if (ent.type !== "blob" || !wanted(dirs, ent.path)) continue
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

async function putBlob(
  env: Env,
  repo: string,
  commit: string,
  relPath: string,
  key: string,
  sha: string,
): Promise<"copied" | "skipped"> {
  const existing = await env.ILLS.head(key)
  if (existing?.customMetadata?.gitSha === sha) return "skipped"
  const raw = `https://raw.githubusercontent.com/${repo}/${commit}/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`
  const res = await fetch(raw, { headers: { "User-Agent": "phi-ill-sync" } })
  if (!res.ok) throw new Error(`raw ${res.status} ${relPath}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  await env.ILLS.put(key, buf, {
    httpMetadata: { contentType: mimeOf(relPath) },
    customMetadata: { gitSha: sha },
  })
  return "copied"
}

async function putOne(env: Env, commit: string, file: FileEnt): Promise<"copied" | "skipped"> {
  return putBlob(env, env.ILL_REPO, commit, file.path, r2Key(env, file.path), file.sha)
}

async function dropStale(env: Env, prefix: string, keep: Set<string>): Promise<number> {
  let cursor: string | undefined
  const stale: string[] = []
  for (;;) {
    const page = await env.ILLS.list({ prefix, cursor, limit: 1000 })
    for (const obj of page.objects) {
      const rel = obj.key.slice(prefix.length)
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

type RunSummary = NonNullable<State["lastRun"]>

async function drain(
  state: { pending: FileEnt[]; manifest: Record<string, string>; lastError?: string },
  commit: string,
  put: (file: FileEnt) => Promise<"copied" | "skipped">,
): Promise<RunSummary> {
  const started = Date.now()
  let copied = 0
  let skipped = 0
  let failed = 0
  const leftover: FileEnt[] = []
  const queue = state.pending.slice()

  const run = async (file: FileEnt) => {
    try {
      if ((await put(file)) === "copied") copied += 1
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
  return { copied, skipped, failed, remaining: leftover.length, ms: Date.now() - started, commit }
}

async function copyBatch(env: Env, commit: string, state: State): Promise<RunSummary> {
  const run = await drain(state, commit, file => putOne(env, commit, file))
  if (!state.pending.length) {
    state.commit = commit
    state.lastError = undefined
    if (state.live.length) {
      const keep = new Set(state.live)
      for (const path of Object.keys(state.manifest)) {
        if (!keep.has(path)) delete state.manifest[path]
      }
      await dropStale(env, `${prefixOf(env)}/`, keep)
    }
  }
  return run
}

async function syncIlls(env: Env): Promise<State> {
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

function infoRepo(env: Env): string {
  return env.INFO_REPO?.trim() || "Catrong/phi-plugin"
}

function infoRef(env: Env): string {
  return env.INFO_REF?.trim() || "main"
}

function infoPrefixOf(env: Env): string {
  return (env.INFO_PREFIX || "info").replace(/\/+$/, "")
}

function infoFileNames(env: Env): string[] {
  return (env.INFO_FILES || DEFAULT_INFO_FILES.join(","))
    .split(",")
    .map(s => s.trim())
    .filter(name => name && name !== "info.csv")
}

function htmlPrefixOf(env: Env): string {
  return (env.HTML_PREFIX || "html").replace(/\/+$/, "")
}

function csvList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

async function listHtml(env: Env, commit: string): Promise<FileEnt[]> {
  const keepByDir = new Map<string, Set<string> | null>()
  for (const dir of csvList(env.HTML_DIRS, DEFAULT_HTML_DIRS)) keepByDir.set(dir, null)
  for (const file of csvList(env.HTML_FILES, DEFAULT_HTML_FILES)) {
    const i = file.lastIndexOf("/")
    if (i < 0) continue
    const dir = file.slice(0, i)
    const cur = keepByDir.get(dir)
    if (cur === null) continue
    const names = cur ?? new Set<string>()
    names.add(file.slice(i + 1))
    keepByDir.set(dir, names)
  }
  const out: FileEnt[] = []
  for (const [dir, keep] of keepByDir) {
    const path = dir.split("/").map(encodeURIComponent).join("/")
    const res = await gh(env, `https://api.github.com/repos/${infoRepo(env)}/contents/resources/html/${path}?ref=${commit}`)
    const body = (await res.json()) as { name: string; sha: string; size?: number; type: string }[]
    if (!Array.isArray(body)) throw new Error(`GitHub contents ${dir} is not a directory`)
    for (const ent of body) {
      if (ent.type !== "file" || !IMAGE_EXT.has(extOf(ent.name))) continue
      if (keep && !keep.has(ent.name)) continue
      out.push({ path: `html/${dir}/${ent.name}`, sha: ent.sha, size: ent.size || 0 })
    }
  }
  return out
}

async function loadInfoState(env: Env): Promise<InfoState> {
  const obj = await env.ILLS.get(INFO_STATE_KEY)
  if (!obj) return { manifest: {}, pending: [], live: [] }
  try {
    const parsed = JSON.parse(await obj.text()) as InfoState
    return {
      commit: parsed.commit,
      target: parsed.target,
      manifest: parsed.manifest && typeof parsed.manifest === "object" ? parsed.manifest : {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      live: Array.isArray(parsed.live) ? parsed.live : [],
      phigros: parsed.phigros,
      phigrosVerNum: parsed.phigrosVerNum,
      levelsSha: parsed.levelsSha,
      levelsSongs: parsed.levelsSongs,
      levelsMax: parsed.levelsMax,
      levelsError: parsed.levelsError,
      tagTreeSha: parsed.tagTreeSha,
      tagTreeError: parsed.tagTreeError,
      updatedAt: parsed.updatedAt,
      lastError: parsed.lastError,
      lastRun: parsed.lastRun,
    }
  } catch {
    return { manifest: {}, pending: [], live: [] }
  }
}

async function saveInfoState(env: Env, state: InfoState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await env.ILLS.put(INFO_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  })
}

function infoFileList(env: Env, commit: string): FileEnt[] {
  return infoFileNames(env).map(path => ({ path, sha: commit, size: 0 }))
}

async function readPhigrosVersion(
  env: Env,
  commit: string,
  from = 140,
): Promise<{ phigros: string; phigrosVerNum: number } | undefined> {
  const repo = infoRepo(env)
  let last: { phigros: string; phigrosVerNum: number } | undefined
  let misses = 0
  const start = Math.max(1, from)
  for (let n = start; n < start + 80 && misses < 5; n++) {
    const raw = `https://raw.githubusercontent.com/${repo}/${commit}/resources/info/oldInfo/${n}/info.json`
    const infoRes = await fetch(raw, { headers: { "User-Agent": "phi-ill-sync" } })
    if (!infoRes.ok) {
      misses += 1
      continue
    }
    misses = 0
    const json = (await infoRes.json()) as { version_label?: string }
    last = { phigros: json.version_label || String(n), phigrosVerNum: n }
  }
  return last
}

function htmlRel(path: string): string {
  return path.slice("html/".length)
}

async function copyInfo(env: Env, commit: string, state: InfoState): Promise<RunSummary> {
  const repo = infoRepo(env)
  const run = await drain(state, commit, file =>
    file.path.startsWith("html/")
      ? putBlob(env, repo, commit, `resources/${file.path}`, `${htmlPrefixOf(env)}/${htmlRel(file.path)}`, file.sha)
      : putBlob(env, repo, commit, `resources/info/${file.path}`, `${infoPrefixOf(env)}/${file.path}`, file.sha),
  )
  if (!state.pending.length) {
    state.commit = commit
    state.lastError = undefined
    if (state.live.length) {
      const keep = new Set(state.live)
      for (const path of Object.keys(state.manifest)) {
        if (path.startsWith("html/") && !keep.has(path)) delete state.manifest[path]
      }
      await dropStale(env, `${htmlPrefixOf(env)}/`, new Set(state.live.map(htmlRel)))
    }
  }
  return run
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function infoFileUrl(env: Env): string {
  return env.INFOFILE_URL?.trim() || DEFAULT_INFOFILE_URL
}

function tagTreeUrl(env: Env): string {
  return env.TAGTREE_URL?.trim() || DEFAULT_TAGTREE_URL
}

function infoKvKey(env: Env): string {
  return env.INFO_KV_KEY?.trim() || DEFAULT_INFO_KV_KEY
}

async function syncLevels(env: Env, state: InfoState): Promise<{ copied: boolean; sha: string; songs: number; maxDifficulty: number }> {
  const res = await fetch(infoFileUrl(env), {
    headers: { Accept: "application/json", "User-Agent": "phi-ill-sync" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`infoFile ${res.status}`)
  const text = await res.text()
  const songs = parseInfoFile(JSON.parse(text) as unknown)
  const csv = infoFileToCsv(songs)
  const summary = summarizeInfoFile(songs)
  const sha = await sha256Hex(text)
  const unchanged = state.levelsSha === sha
  const payload = JSON.stringify({
    sha,
    csv,
    songs: summary.songs,
    maxDifficulty: summary.maxDifficulty,
    updatedAt: new Date().toISOString(),
  })
  if (!unchanged) {
    const prefix = infoPrefixOf(env)
    await env.ILLS.put(`${prefix}/info.csv`, csv, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
      customMetadata: { levelsSha: sha },
    })
    if (!env.KV) throw new Error("KV binding missing")
    await env.KV.put(infoKvKey(env), payload)
    state.levelsSha = sha
    state.levelsSongs = summary.songs
    state.levelsMax = summary.maxDifficulty
    state.manifest["info.csv"] = sha
  }
  state.levelsError = undefined
  return { copied: !unchanged, sha, songs: summary.songs, maxDifficulty: summary.maxDifficulty }
}

async function syncTagTree(env: Env, state: InfoState): Promise<{ copied: boolean; sha: string }> {
  const res = await fetch(tagTreeUrl(env), {
    headers: { Accept: "application/json", "User-Agent": "phi-ill-sync" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`tagTree ${res.status}`)
  const text = await res.text()
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object") throw new Error("tagTree invalid")
  const sha = await sha256Hex(text)
  const unchanged = state.tagTreeSha === sha
  if (!unchanged) {
    const prefix = infoPrefixOf(env)
    await env.ILLS.put(`${prefix}/tagTree.json`, text, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { tagTreeSha: sha },
    })
    state.tagTreeSha = sha
    state.manifest["tagTree.json"] = sha
  }
  state.tagTreeError = undefined
  return { copied: !unchanged, sha }
}

async function syncInfo(env: Env): Promise<InfoState> {
  const state = await loadInfoState(env)
  const commit = await headCommit(env, infoRepo(env), infoRef(env))
  const upToDate =
    (state.target === commit && state.pending.length > 0) || (state.commit === commit && !state.pending.length)
  if (!upToDate || !state.live.length) {
    const html = await listHtml(env, commit)
    const files = [...infoFileList(env, commit), ...html]
    state.target = commit
    state.live = html.map(file => file.path)
    state.pending = files.filter(file => state.manifest[file.path] !== file.sha)
    const ver = await readPhigrosVersion(env, commit, state.phigrosVerNum || 140)
    if (ver) {
      state.phigros = ver.phigros
      state.phigrosVerNum = ver.phigrosVerNum
    }
    if (!state.pending.length) state.commit = commit
  }
  if (state.pending.length) state.lastRun = await copyInfo(env, commit, state)
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
  try {
    if ((await syncLevels(env, state)).copied) countCopied(state, commit)
  } catch (err) {
    state.levelsError = err instanceof Error ? err.message : String(err)
  }
  try {
    if ((await syncTagTree(env, state)).copied) countCopied(state, commit)
  } catch (err) {
    state.tagTreeError = err instanceof Error ? err.message : String(err)
  }
  await saveInfoState(env, state)
  return state
}

function countCopied(state: InfoState, commit: string) {
  const last = state.lastRun
  state.lastRun = {
    copied: (last?.copied || 0) + 1,
    skipped: last?.skipped || 0,
    failed: last?.failed || 0,
    remaining: last?.remaining || 0,
    ms: last?.ms || 0,
    commit,
  }
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

function publicInfoState(state: InfoState) {
  return {
    commit: state.commit,
    pending: state.pending.length,
    files: Object.keys(state.manifest).length,
    phigros: state.phigros,
    phigrosVerNum: state.phigrosVerNum,
    levelsSha: state.levelsSha,
    levelsSongs: state.levelsSongs,
    levelsMax: state.levelsMax,
    levelsError: state.levelsError,
    tagTreeSha: state.tagTreeSha,
    tagTreeError: state.tagTreeError,
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

async function proxyTap(req: Request): Promise<Response | undefined> {
  if (new URL(req.url).pathname !== "/tap-proxy") return
  const dest = tapProxyTarget(req.headers.get("x-tap-target"))
  if (!dest) return new Response("not found", { status: 404 })
  const headers = tapProxyHeaders(req.headers)
  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
  let last: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(dest, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(45_000),
      })
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") || "application/octet-stream" },
      })
    } catch (err) {
      last = err
    }
  }
  return Response.json(
    { error: last instanceof Error ? last.message : String(last) },
    { status: 504 },
  )
}

async function proxyChartTag(req: Request, env: Env): Promise<Response | undefined> {
  const dest = chartTagProxyUrl(
    req.method,
    new URL(req.url).pathname,
    env.CHART_TAG_API?.trim() || DEFAULT_CHART_TAG_API,
  )
  if (!dest) return
  try {
    const res = await fetch(dest, {
      method: req.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "phi-ill-sync",
      },
      body: req.method === "POST" ? await req.text() : undefined,
      signal: AbortSignal.timeout(25_000),
    })
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json" },
    })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 504 },
    )
  }
}

export default {
  async scheduled(_controller: { cron: string }, env: Env) {
    try {
      const info = await syncInfo(env)
      console.log("info-sync", JSON.stringify(publicInfoState(info)))
    } catch (err) {
      console.log("info-sync", JSON.stringify({ lastError: err instanceof Error ? err.message : String(err) }))
    }
    try {
      const ill = await syncIlls(env)
      console.log("ill-sync", JSON.stringify(publicState(ill)))
    } catch (err) {
      console.log("ill-sync", JSON.stringify({ lastError: err instanceof Error ? err.message : String(err) }))
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const isProxy =
      url.pathname === "/tap-proxy" ||
      Boolean(chartTagProxyUrl(req.method, url.pathname, env.CHART_TAG_API?.trim() || DEFAULT_CHART_TAG_API))
    if (isProxy) {
      if (!proxyAuthorized(req.headers, env.PROXY_SECRET)) {
        return new Response("unauthorized", { status: 401 })
      }
      const tap = await proxyTap(req)
      if (tap) return tap
      const proxied = await proxyChartTag(req, env)
      if (proxied) return proxied
    }
    if (!authorized(req, env)) return new Response("not found", { status: 404 })
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json(publicState(await loadState(env)))
    }
    if (req.method === "GET" && url.pathname === "/info") {
      return Response.json(publicInfoState(await loadInfoState(env)))
    }
    if ((req.method === "POST" || req.method === "GET") && url.pathname === "/sync") {
      let info: ReturnType<typeof publicInfoState> | { lastError: string }
      let ill: ReturnType<typeof publicState> | { lastError: string }
      try {
        info = publicInfoState(await syncInfo(env))
      } catch (err) {
        info = { lastError: err instanceof Error ? err.message : String(err) }
      }
      try {
        ill = publicState(await syncIlls(env))
      } catch (err) {
        ill = { lastError: err instanceof Error ? err.message : String(err) }
      }
      return Response.json({ info, ill })
    }
    return new Response("not found", { status: 404 })
  },
}
