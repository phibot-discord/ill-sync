# PhiBot ill-sync

Syncs Catrong/phi-plugin-ill jackets into Cloudflare R2 (`phi-web-assets`), and chart levels from [phib19 infoFile](https://phib19.top:8080/get/infoFile) into R2 + KV.

Cron (`*/15 * * * *`) writes:

- `original_ill/**` — `illLow`, `illBlur`, `SP`, `chap`, `chartimg` from GitHub
- `info/*` — nicklist, notes, tips, … from Catrong/phi-plugin
- `info/info.csv` — generated from phib19 (not GitHub; upstream info.csv is stale)
- `phi:infoFile` in KV — `{ sha, csv, songs, maxDifficulty, updatedAt }` for fast WebUI / bot reads
- `_sync/ills.json` / `_sync/info.json` — commit, `levelsSha`, pending counts

WebUI hydrates catalog extras from `_sync/info.json` and overlays `phi:infoFile` from KV so difficulties update without waiting on phi-plugin.

Commit polling for GitHub uses git refs / atom, not GitHub REST, so Cloudflare's shared IP does not hit the 60 req/hour REST cap. Optional `GITHUB_TOKEN` secret is only needed if a new illustration commit must list the git tree.
