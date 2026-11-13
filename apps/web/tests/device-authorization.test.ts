import { test } from "node:test";
import assert from "node:assert/strict";
import { oidcLoginPath } from "../src/authentication.js";
import { authorizationCallbackUrl } from "../src/device-authorization.js";

const state = "a".repeat(43);
const extension = "a".repeat(32) + ".chromiumapp.org";
const query = `?code=${"c".repeat(43)}&state=${state}`;

test("authorization callbacks accept only the declared local and browser receivers", () => {
  for (const address of ["127.0.0.1:49152", "[::1]:49152"]) {
    const callback = `http://${address}/abridge/callback${query}`;
    assert.equal(authorizationCallbackUrl(callback, "computer"), callback);
  }
  const browser = `https://${extension}/abridge-authorize${query}`;
  assert.equal(authorizationCallbackUrl(browser, "browser"), browser);
  const rejected = `http://127.0.0.1:49152/abridge/callback?error=access_denied&state=${state}`;
  assert.equal(authorizationCallbackUrl(rejected, "computer"), rejected);
});

test("authorization callbacks refuse external hosts, wrong clients, paths and credentials", () => {
  const invalid = [
    `https://example.com/abridge/callback${query}`,
    `http://localhost:49152/abridge/callback${query}`,
    `http://127.0.0.1/abridge/callback${query}`,
    `http://127.0.0.1:0/abridge/callback${query}`,
    `http://127.0.0.1:49152/other${query}`,
    `https://127.0.0.1:49152/abridge/callback${query}`,
    `http://name@127.0.0.1:49152/abridge/callback${query}`,
    `http://127.0.0.1:49152/abridge/callback${query}#secret`,
    `https://${extension}/abridge-authorize${query}`,
    `javascript:alert(1)`,
  ];
  for (const callback of invalid)
    assert.throws(() => authorizationCallbackUrl(callback, "computer"), callback);
  for (const callback of [
    `http://${extension}/abridge-authorize${query}`,
    `https://${extension}:8443/abridge-authorize${query}`,
    `https://${extension}.example.com/abridge-authorize${query}`,
    `https://not-an-extension.chromiumapp.org/abridge-authorize${query}`,
    `https://${extension}/wrong${query}`,
    `http://127.0.0.1:49152/abridge/callback${query}`,
  ])
    assert.throws(() => authorizationCallbackUrl(callback, "browser"), callback);
});

test("authorization callbacks reject duplicate, missing or secret-bearing query fields", () => {
  const callback = "http://127.0.0.1:49152/abridge/callback";
  for (const parameters of [
    "",
    "?code=code",
    `?state=${state}`,
    `?code=&state=${state}`,
    "?code=code&state=short",
    `?code=code&state=${"a".repeat(257)}`,
    `?code=${"a".repeat(513)}&state=${state}`,
    `?code=code&state=${state}&state=${state}`,
    `?code=code&code=other&state=${state}`,
    `?code=code&error=access_denied&state=${state}`,
    `?error=unknown&state=${state}`,
    `?error=access_denied&error=access_denied&state=${state}`,
    `?token=abr_device_secret&state=${state}`,
    `?key=abr_device_secret&state=${state}`,
    `?code=code&state=${state}&key=abr_device_secret`,
    "?code=code&state=%3Cscript%3E",
  ])
    assert.throws(() => authorizationCallbackUrl(callback + parameters, "computer"), parameters);
});

test("OIDC login retains the actual device authorization query without forwarding unrelated queries", () => {
  const id = "fixture_Authorization-123";
  const location = new URL(oidcLoginPath("?authorize=" + id, ""), "https://bridge.example");
  assert.equal(location.searchParams.get("return_to"), "/?authorize=" + id);
  for (const search of [
    "?authorize=a&authorize=b",
    "?authorize=a&token=secret",
    "?return_to=https://evil.example",
    "?authorize=",
  ]) {
    assert.equal(
      new URL(oidcLoginPath(search, ""), "https://bridge.example").searchParams.get("return_to"),
      "/",
    );
  }
});
