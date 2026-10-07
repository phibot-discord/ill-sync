import assert from "node:assert/strict";
import test from "node:test";
import { summarizeInfoCsv } from "./info-file.ts";

const HEADER =
	"id\tsong\tcomposer\tillustrator\tEZC\tHDC\tINC\tATC\tEZ\tHD\tIN\tAT";

test("summarizeInfoCsv counts songs and the highest chart constant", () => {
	const csv = [
		HEADER,
		"Glaciaxion.SunsetRay\tGlaciaxion\tSunsetRay\t艾若拉\tB\tC\tB vs. N\t\t1.0\t6.5\t12.6\t",
		"Credits.Frums\tCredits\tFrums\tCtymax\tCtymax\tCtymax\tCtymax\t_鉄 (Isotope 59)\t4.5\t10.4\t13.6\t15.8",
		"",
	].join("\r\n");
	assert.deepEqual(summarizeInfoCsv(csv), { songs: 2, maxDifficulty: 15.8 });
});

test("summarizeInfoCsv ignores blank and non-numeric constants", () => {
	const csv = `${HEADER}\na\tA\tc\ti\t\t\t\t\t\t?\t13.2\t\n\n`;
	assert.deepEqual(summarizeInfoCsv(csv), { songs: 1, maxDifficulty: 13.2 });
	assert.deepEqual(summarizeInfoCsv(`${HEADER}\n`), {
		songs: 0,
		maxDifficulty: 0,
	});
});

test("summarizeInfoCsv rejects a file without level columns", () => {
	assert.throws(
		() => summarizeInfoCsv("id\tsong\na\tA\n"),
		/unexpected header/,
	);
	assert.throws(() => summarizeInfoCsv(""), /unexpected header/);
});
