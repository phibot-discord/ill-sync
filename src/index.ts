/**
 * Mirror Catrong/phi-plugin-ill jackets from GitHub, and chart levels from phib19.
 */

import { infoFileToCsv, parseInfoFile, summarizeInfoFile } from "./info-file"

const STATE_KEY = "_sync/ills.json"
const INFO_STATE_KEY = "_sync/info.json"
const TIME_BUDGET_MS = 25_000
const CONCURRENCY = 4
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
const DEFAULT_INFOFILE_URL = "https://phib19.top:8080/get/infoFile"
const DEFAULT_INFO_KV_KEY = "phi:infoFile"
const DEFAULT_INFO_FILES = [
  "avatar.txt",
  "infolist.json",
  "nicklist.yaml",
  "notesInfo.json",
  "spinfo.json",
  "tips.txt",
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
  INFOFILE_URL?: string
  INFO_KV_KEY?: string
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

type InfoState = {
  commit?: string
  target?: string
  manifest: Record<string, string>
  pending: FileEnt[]
  phigros?: string
  phigrosVerNum?: number
  levelsSha?: string
  levelsSongs?: number
  levelsMax?: number
  levelsError?: string
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

async function loadInfoState(env: Env): Promise<InfoState> {
  const obj = await env.ILLS.get(INFO_STATE_KEY)
  if (!obj) return { manifest: {}, pending: [] }
  try {
    const parsed = JSON.parse(await obj.text()) as InfoState
    return {
      commit: parsed.commit,
      target: parsed.target,
      manifest: parsed.manifest && typeof parsed.manifest === "object" ? parsed.manifest : {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      phigros: parsed.phigros,
      phigrosVerNum: parsed.phigrosVerNum,
      levelsSha: parsed.levelsSha,
      levelsSongs: parsed.levelsSongs,
      levelsMax: parsed.levelsMax,
      levelsError: parsed.levelsError,
      updatedAt: parsed.updatedAt,
      lastError: parsed.lastError,
      lastRun: parsed.lastRun,
    }
  } catch {
    return { manifest: {}, pending: [] }
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

async function copyInfo(env: Env, commit: string, state: InfoState): Promise<NonNullable<InfoState["lastRun"]>> {
  const started = Date.now()
  let copied = 0
  let skipped = 0
  let failed = 0
  const leftover: FileEnt[] = []
  const repo = infoRepo(env)
  const prefix = infoPrefixOf(env)
  for (const file of state.pending) {
    if (file.path === "info.csv") continue
    try {
      const kind = await putBlob(
        env,
        repo,
        commit,
        `resources/info/${file.path}`,
        `${prefix}/${file.path}`,
        file.sha,
      )
      if (kind === "copied") copied += 1
      else skipped += 1
      state.manifest[file.path] = file.sha
    } catch (err) {
      failed += 1
      leftover.push(file)
      state.lastError = err instanceof Error ? err.message : String(err)
    }
  }
  state.pending = leftover.filter(file => file.path !== "info.csv")
  if (!state.pending.length) {
    state.commit = commit
    state.lastError = undefined
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

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function infoFileUrl(env: Env): string {
  return env.INFOFILE_URL?.trim() || DEFAULT_INFOFILE_URL
}

function infoKvKey(env: Env): string {
  return env.INFO_KV_KEY?.trim() || DEFAULT_INFO_KV_KEY
}

export async function syncLevels(env: Env, state: InfoState): Promise<{ copied: boolean; sha: string; songs: number; maxDifficulty: number }> {
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

export async function syncInfo(env: Env): Promise<InfoState> {
  const state = await loadInfoState(env)
  const commit = await headCommit(env, infoRepo(env), infoRef(env))
  if (!(state.target === commit && state.pending.length) && !(state.commit === commit && !state.pending.length)) {
    const files = infoFileList(env, commit)
    state.target = commit
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
    const levels = await syncLevels(env, state)
    if (levels.copied) {
      state.lastRun = {
        copied: (state.lastRun?.copied || 0) + 1,
        skipped: state.lastRun?.skipped || 0,
        failed: state.lastRun?.failed || 0,
        remaining: state.lastRun?.remaining || 0,
        ms: state.lastRun?.ms || 0,
        commit,
      }
    }
  } catch (err) {
    state.levelsError = err instanceof Error ? err.message : String(err)
  }
  await saveInfoState(env, state)
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
    if (!authorized(req, env)) return new Response("not found", { status: 404 })
    const url = new URL(req.url)
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
