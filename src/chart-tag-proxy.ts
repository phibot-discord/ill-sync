export const DEFAULT_CHART_TAG_API = "https://phib19.top:8080";

const CHART_TAG_GET = new Set([
	"/chartsTag/get/tagTree",
	"/chartsTag/get/tagNames",
]);
const CHART_TAG_POST = new Set([
	"/chartsTag/get/b30Analysis",
	"/get/scoreList/allAccAvg",
	"/get/scoreList/allAccAvgB30",
	"/get/scoreList/allAccRank",
	"/get/scoreList/songAccList",
	"/get/scoreList/songApFcCount",
]);

export function chartTagProxyUrl(
	method: string,
	pathname: string,
	origin = DEFAULT_CHART_TAG_API,
): string | undefined {
	const path = pathname.replace(/\/+$/, "") || "/";
	const base = origin.replace(/\/+$/, "");
	if (method === "GET" && CHART_TAG_GET.has(path)) return `${base}${path}`;
	if (method === "POST" && CHART_TAG_POST.has(path)) return `${base}${path}`;
}
