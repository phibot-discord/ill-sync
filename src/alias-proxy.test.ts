import assert from "node:assert/strict";
import test from "node:test";
import { aliasProxyTarget, isAliasProxyPath } from "./alias-proxy.ts";

const ORIGIN = "https://phib19.top:8080";
const target = (path: string) =>
	aliasProxyTarget(new URL(path, "https://w.test"), ORIGIN);

test("only the read-only alias GET routes are proxied", () => {
	for (const path of [
		"/aliases/resolve",
		"/aliases",
		"/alias-proposals/public",
		"/alias-proposals/export/nicklist.json",
	]) {
		assert.equal(isAliasProxyPath("GET", path), true, path);
		assert.equal(isAliasProxyPath("POST", path), false, path);
	}
	assert.equal(isAliasProxyPath("GET", "/aliases/"), true);
	for (const path of [
		"/aliases/list",
		"/alias-proposals",
		"/alias-proposals/mine",
		"/alias-proposals/public/list",
		"/alias-proposals/1/vote",
		"/alias-proposals/export/nicklist.yaml",
		"/__proto__",
		"/constructor",
		"/",
	]) {
		assert.equal(isAliasProxyPath("GET", path), false, path);
		assert.equal(target(path), undefined, path);
	}
});

test("resolve rebuilds the query from a trimmed alias of 1..64 chars", () => {
	assert.deepEqual(target("/aliases/resolve?alias=%20ASA%20"), {
		ok: true,
		url: `${ORIGIN}/aliases/resolve?alias=ASA`,
	});
	assert.deepEqual(target("/aliases/resolve?alias=%E9%B8%BD%E6%B8%B8"), {
		ok: true,
		url: `${ORIGIN}/aliases/resolve?alias=%E9%B8%BD%E6%B8%B8`,
	});
	assert.deepEqual(target("/aliases/resolve?alias=a%26b%3Dc"), {
		ok: true,
		url: `${ORIGIN}/aliases/resolve?alias=a%26b%3Dc`,
	});
	assert.equal(target(`/aliases/resolve?alias=${"x".repeat(64)}`)?.ok, true);
	for (const query of [
		"",
		"?alias=",
		"?alias=%20%20",
		`?alias=${"x".repeat(65)}`,
		"?alias=a&alias=b",
		"?alias=a&x=1",
	]) {
		const res = target(`/aliases/resolve${query}`);
		assert.equal(res?.ok, false, query);
	}
});

test("list routes take limit 1..200 and offset >= 0, defaulting both", () => {
	assert.deepEqual(target("/aliases?limit=200&offset=1800"), {
		ok: true,
		url: `${ORIGIN}/aliases?limit=200&offset=1800`,
	});
	assert.deepEqual(target("/aliases?offset=007"), {
		ok: true,
		url: `${ORIGIN}/aliases?limit=100&offset=7`,
	});
	assert.deepEqual(target("/alias-proposals/public"), {
		ok: true,
		url: `${ORIGIN}/alias-proposals/public?limit=100&offset=0`,
	});
	for (const query of [
		"?limit=0",
		"?limit=201",
		"?limit=-1",
		"?limit=1.5",
		"?limit=abc",
		"?offset=-1",
		"?offset=1e3",
		"?alias=x",
		"?limit=1&limit=2",
	]) {
		assert.equal(target(`/aliases${query}`)?.ok, false, query);
	}
});

test("the export takes no parameters", () => {
	assert.deepEqual(target("/alias-proposals/export/nicklist.json"), {
		ok: true,
		url: `${ORIGIN}/alias-proposals/export/nicklist.json`,
	});
	assert.equal(target("/alias-proposals/export/nicklist.json?x=1")?.ok, false);
});
