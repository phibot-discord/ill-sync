import assert from "node:assert/strict"
import test from "node:test"
import { chartTagProxyUrl, DEFAULT_CHART_TAG_API } from "./chart-tag-proxy.ts"

test("proxies only the no-auth GET/POST chart-tag routes", () => {
  assert.equal(DEFAULT_CHART_TAG_API, "https://phib19.top:8080")
  assert.equal(
    chartTagProxyUrl("GET", "/chartsTag/get/tagTree"),
    "https://phib19.top:8080/chartsTag/get/tagTree",
  )
  assert.equal(
    chartTagProxyUrl("GET", "/chartsTag/get/tagNames"),
    "https://phib19.top:8080/chartsTag/get/tagNames",
  )
  assert.equal(
    chartTagProxyUrl("POST", "/chartsTag/get/b30Analysis"),
    "https://phib19.top:8080/chartsTag/get/b30Analysis",
  )
  assert.equal(
    chartTagProxyUrl("POST", "/get/scoreList/allAccAvg"),
    "https://phib19.top:8080/get/scoreList/allAccAvg",
  )
  assert.equal(
    chartTagProxyUrl("POST", "/get/scoreList/allAccAvgB30"),
    "https://phib19.top:8080/get/scoreList/allAccAvgB30",
  )
  assert.equal(
    chartTagProxyUrl("POST", "/get/scoreList/allAccRank"),
    "https://phib19.top:8080/get/scoreList/allAccRank",
  )
  assert.equal(chartTagProxyUrl("POST", "/chartsTag/get/tagTree"), undefined)
  assert.equal(chartTagProxyUrl("GET", "/chartsTag/get/b30Analysis"), undefined)
  assert.equal(chartTagProxyUrl("GET", "/get/scoreList/allAccAvg"), undefined)
  assert.equal(chartTagProxyUrl("POST", "/chartsTag/get/chartsTags"), undefined)
  assert.equal(chartTagProxyUrl("POST", "/chartsTag/get/usersVote"), undefined)
  assert.equal(chartTagProxyUrl("POST", "/chartsTag/set/set"), undefined)
  assert.equal(chartTagProxyUrl("GET", "/sync"), undefined)
})
