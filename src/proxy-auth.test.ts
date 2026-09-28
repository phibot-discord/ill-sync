import assert from "node:assert/strict"
import test from "node:test"
import { PROXY_KEY_HEADER, proxyAuthorized } from "./proxy-auth.ts"

const headers = (key?: string) => new Headers(key == null ? {} : { [PROXY_KEY_HEADER]: key })

test("proxy accepts only the configured secret", () => {
  assert.equal(proxyAuthorized(headers("s3cret"), "s3cret"), true)
  assert.equal(proxyAuthorized(headers(" s3cret "), "s3cret"), true)
  assert.equal(proxyAuthorized(headers("s3cre"), "s3cret"), false)
  assert.equal(proxyAuthorized(headers("s3cret!"), "s3cret"), false)
  assert.equal(proxyAuthorized(headers(), "s3cret"), false)
})

test("proxy is closed when no secret is configured", () => {
  assert.equal(proxyAuthorized(headers("anything"), undefined), false)
  assert.equal(proxyAuthorized(headers("anything"), ""), false)
  assert.equal(proxyAuthorized(headers(""), ""), false)
})
