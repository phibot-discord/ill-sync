import assert from "node:assert/strict";
import test from "node:test";
import { tapProxyHeaders, tapProxyTarget } from "./tap-proxy.ts";

test("tap proxy allowlists CN TapTap hosts only", () => {
	assert.equal(
		tapProxyTarget("https://rak3ffdi.cloud.tds1.tapapis.cn/1.1/users/me"),
		"https://rak3ffdi.cloud.tds1.tapapis.cn/1.1/users/me",
	);
	assert.equal(
		tapProxyTarget("https://accounts.tapapis.cn/oauth2/v1/token"),
		"https://accounts.tapapis.cn/oauth2/v1/token",
	);
	assert.ok(tapProxyTarget("https://file.tapfiles.cn/save.zip"));
	assert.equal(
		tapProxyTarget("https://kviehlel.cloud.ap-sg.tapapis.com/1.1/users/me"),
		undefined,
	);
	assert.equal(
		tapProxyTarget("https://accounts.tapapis.com/oauth2/v1/token"),
		undefined,
	);
	assert.equal(
		tapProxyTarget("http://rak3ffdi.cloud.tds1.tapapis.cn/1.1/users/me"),
		undefined,
	);
	assert.equal(tapProxyTarget("https://example.com/"), undefined);
	assert.equal(tapProxyTarget("not a url"), undefined);
});

test("tap proxy restores MAC from x-tap-authorization", () => {
	const mac = 'MAC id="kid", ts="1", nonce="n", mac="m"';
	const fromCopy = tapProxyHeaders(
		new Headers({
			"x-tap-authorization": mac,
			"x-lc-id": "rAK3FfdieFob2Nn8Am",
		}),
	);
	assert.equal(fromCopy.get("authorization"), mac);
	assert.equal(fromCopy.get("x-lc-id"), "rAK3FfdieFob2Nn8Am");
	const fromAuth = tapProxyHeaders(new Headers({ authorization: mac }));
	assert.equal(fromAuth.get("authorization"), mac);
});
