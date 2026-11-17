import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname } from "node:path";

assert.equal(process.env.PI_VERTEX_FIXTURE_GUARD, "isolated-dummy-adc-only");
assert.equal(dirname(process.env.GOOGLE_APPLICATION_CREDENTIALS), process.env.HOME);
try {
  const adc = JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  assert.ok(
    JSON.stringify(adc) === "{}" ||
      (adc.type === "authorized_user" &&
        adc.client_id === "fixture-client" &&
        adc.client_secret === "fixture-secret" &&
        adc.refresh_token === "fixture-refresh" &&
        adc.quota_project_id === "ignored-adc-quota" &&
        Object.keys(adc).length === 5),
    "Refusing to intercept non-fixture ADC",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const fixture = process.env.PI_VERTEX_FIXTURE_URL;
assert.match(fixture, /^http:\/\/127\.0\.0\.1:\d+$/);
const port = new URL(fixture).port;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  const host = typeof options === "object" ? options.host : normalized[1];
  const requestedPort = typeof options === "object" ? options.port : options;
  assert.equal(host, "127.0.0.1", "Test process attempted a non-loopback connection");
  assert.equal(String(requestedPort), port, "Test process attempted an unowned port");
  return connect.apply(this, args);
};
syncBuiltinESMExports();

const googleOrigins = new Set([
  "https://oauth2.googleapis.com",
  "https://aiplatform.googleapis.com",
  "https://us-central1-aiplatform.googleapis.com",
]);
let originalFetch = globalThis.fetch;
const fixtureFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!googleOrigins.has(url.origin)) {
    assert.equal(url.origin, fixture, "Unexpected fetch origin in isolated test process");
    return originalFetch(request);
  }
  return originalFetch(`${fixture}/protocol`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-original-origin": url.origin },
    signal: request.signal,
    body: JSON.stringify({
      uri: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    }),
  });
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  get: () => fixtureFetch,
  set: (implementation) => {
    if (implementation !== fixtureFetch) originalFetch = implementation;
  },
});
