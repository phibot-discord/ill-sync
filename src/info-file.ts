export const LEVELS = ["EZ", "HD", "IN", "AT"] as const
export const CSV_HEADER = "id\tsong\tcomposer\tillustrator\tEZC\tHDC\tINC\tATC\tEZ\tHD\tIN\tAT"

export type InfoChart = { charter?: string; difficulty?: string }
export type InfoSong = {
  id?: string
  song?: string
  composer?: string
  illustrator?: string
  chart?: Partial<Record<(typeof LEVELS)[number], InfoChart>>
}
export type InfoFile = Record<string, InfoSong>

function stripDotZero(id: string) {
  return id.endsWith(".0") ? id.slice(0, -2) : id
}

function cell(value: unknown): string {
  return String(value ?? "").replace(/[\t\r\n]/g, " ")
}

function isSong(value: unknown): value is InfoSong {
  return !!value && typeof value === "object" && "chart" in value
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function pickSongs(obj: Record<string, unknown>): InfoFile {
  const out: InfoFile = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!isSong(value)) continue
    out[key] = value
  }
  return out
}

export function parseInfoFile(raw: unknown): InfoFile {
  const obj = asRecord(raw)
  if (!obj) throw new Error("infoFile: unexpected shape")
  const nested = asRecord(obj.data)
  const source = nested && Object.values(nested).some(isSong) ? nested : obj
  const songs = pickSongs(source)
  if (!Object.keys(songs).length) throw new Error("infoFile: empty")
  return songs
}

export function infoFileToCsv(songs: InfoFile): string {
  const rows = [CSV_HEADER]
  for (const [key, song] of Object.entries(songs)) {
    const chart = song.chart || {}
    rows.push(
      [
        stripDotZero(song.id || key),
        song.song,
        song.composer,
        song.illustrator,
        ...LEVELS.map(level => chart[level]?.charter ?? ""),
        ...LEVELS.map(level => chart[level]?.difficulty ?? ""),
      ]
        .map(cell)
        .join("\t"),
    )
  }
  return `${rows.join("\n")}\n`
}

export function summarizeInfoFile(songs: InfoFile): { songs: number; maxDifficulty: number } {
  let maxDifficulty = 0
  for (const song of Object.values(songs)) {
    for (const level of LEVELS) {
      const n = Number(song.chart?.[level]?.difficulty)
      if (Number.isFinite(n)) maxDifficulty = Math.max(maxDifficulty, n)
    }
  }
  return { songs: Object.keys(songs).length, maxDifficulty }
}
