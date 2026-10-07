const LEVELS = ["EZ", "HD", "IN", "AT"] as const;

export function summarizeInfoCsv(text: string): {
	songs: number;
	maxDifficulty: number;
} {
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	const header = (lines.shift() || "").split("\t");
	const cols = LEVELS.map((level) => header.indexOf(level)).filter(
		(i) => i >= 0,
	);
	if (!cols.length) throw new Error("info.csv: unexpected header");
	let maxDifficulty = 0;
	for (const line of lines) {
		const cells = line.split("\t");
		for (const i of cols) {
			const n = Number(cells[i]);
			if (cells[i] && Number.isFinite(n))
				maxDifficulty = Math.max(maxDifficulty, n);
		}
	}
	return { songs: lines.length, maxDifficulty };
}
