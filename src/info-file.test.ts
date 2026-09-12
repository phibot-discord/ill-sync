import assert from "node:assert/strict"
import test from "node:test"
import { infoFileToCsv, parseInfoFile, summarizeInfoFile } from "./info-file.ts"

const sample = {
  "Glaciaxion.SunsetRay.0": {
    id: "Glaciaxion.SunsetRay.0",
    song: "Glaciaxion",
    composer: "SunsetRay",
    illustrator: "艾若拉",
    chart: {
      EZ: { charter: "Barbarianerman", difficulty: "1.0" },
      HD: { charter: "阿爽 fixed by Clutter", difficulty: "6.5" },
      IN: { charter: "Barbarianerman vs. NerSAN", difficulty: "12.6" },
    },
  },
  "Credits.Frums.0": {
    id: "Credits.Frums.0",
    song: "Credits",
    composer: "Frums",
    illustrator: "Ctymax",
    chart: {
      EZ: { charter: "Ctymax", difficulty: "4.5" },
      HD: { charter: "Ctymax", difficulty: "10.4" },
      IN: { charter: "Ctymax", difficulty: "13.6" },
      AT: { charter: "_鉄 (Isotope 59)", difficulty: "15.8" },
    },
  },
}

test("infoFileToCsv uses tab-separated plugin headers and strips .0 from ids", () => {
  const csv = infoFileToCsv(sample)
  const lines = csv.trimEnd().split("\n")
  assert.equal(lines[0], "id\tsong\tcomposer\tillustrator\tEZC\tHDC\tINC\tATC\tEZ\tHD\tIN\tAT")
  assert.equal(
    lines[1],
    "Glaciaxion.SunsetRay\tGlaciaxion\tSunsetRay\t艾若拉\tBarbarianerman\t阿爽 fixed by Clutter\tBarbarianerman vs. NerSAN\t\t1.0\t6.5\t12.6\t",
  )
  assert.equal(
    lines[2],
    "Credits.Frums\tCredits\tFrums\tCtymax\tCtymax\tCtymax\tCtymax\t_鉄 (Isotope 59)\t4.5\t10.4\t13.6\t15.8",
  )
})

test("parseInfoFile accepts a wrapped { data } payload", () => {
  const songs = parseInfoFile({ data: sample })
  assert.equal(Object.keys(songs).length, 2)
  assert.equal(songs["Credits.Frums.0"]?.chart?.AT?.difficulty, "15.8")
})

test("summarizeInfoFile counts songs and max constant", () => {
  const summary = summarizeInfoFile(sample)
  assert.equal(summary.songs, 2)
  assert.equal(summary.maxDifficulty, 15.8)
})
