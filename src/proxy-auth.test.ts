import assert from "node:assert/strict";
import test from "node:test";
import {
	bearerAuthorized,
	equalSecret,
	PROXY_KEY_HEADER,
	proxyAuthorized,
} from "./proxy-auth.ts";

const headers = (key?: string) =>
	new Headers(key == null ? {} : { [PROXY_KEY_HEADER]: key });

test("proxy accepts only the configured secret", () => {
	assert.equal(proxyAuthorized(headers("s3cret"), "s3cret"), true);
	assert.equal(proxyAuthorized(headers(" s3cret "), "s3cret"), true);
	assert.equal(proxyAuthorized(headers("s3cre"), "s3cret"), false);
	assert.equal(proxyAuthorized(headers("s3cret!"), "s3cret"), false);
	assert.equal(proxyAuthorized(headers(), "s3cret"), false);
});

test("proxy is closed when no secret is configured", () => {
	assert.equal(proxyAuthorized(headers("anything"), undefined), false);
	assert.equal(proxyAuthorized(headers("anything"), ""), false);
	assert.equal(proxyAuthorized(headers(""), ""), false);
});

test("equalSecret compares whole strings, including length and multibyte text", () => {
	assert.equal(equalSecret("abc", "abc"), true);
	assert.equal(equalSecret("abc", "abd"), false);
	assert.equal(equalSecret("abc", "abcd"), false);
	assert.equal(equalSecret("", ""), true);
	assert.equal(equalSecret("鍵", "鍵"), true);
	assert.equal(equalSecret("鍵", "錠"), false);
});

test("bearer accepts any configured secret and nothing else", () => {
	const secrets = ["sync", undefined, " unpack "];
	assert.equal(bearerAuthorized("Bearer sync", secrets), true);
	assert.equal(bearerAuthorized("Bearer unpack", secrets), true);
	assert.equal(bearerAuthorized("Bearer  sync ", secrets), true);
	assert.equal(bearerAuthorized("Bearer syn", secrets), false);
	assert.equal(bearerAuthorized("Bearer ", secrets), false);
	assert.equal(bearerAuthorized("Basic sync", secrets), false);
	assert.equal(bearerAuthorized("sync", secrets), false);
	assert.equal(bearerAuthorized(null, secrets), false);
	assert.equal(bearerAuthorized("Bearer ", ["", undefined]), false);
	assert.equal(bearerAuthorized("Bearer x", []), false);
});
