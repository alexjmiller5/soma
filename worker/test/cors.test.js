import { expect, test } from "bun:test";
import worker from "../src/index.js";
import { D1Shim } from "./d1shim.js";

const APP = "https://iris.example.test";
const env = (extra = {}) => ({ DB: new D1Shim(), HUB_TOKEN: "test", CORS_ORIGINS: `${APP}, http://localhost:5173`, ...extra });
const call = (path, init, e = env()) => worker.fetch(new Request(`https://hub.test${path}`, init), e, { waitUntil() {} });

test("preflight from a configured origin allows the API's methods and headers", async () => {
  const r = await call("/v1/rows/pull", {
    method: "OPTIONS",
    headers: { Origin: APP, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
  });
  expect(r.status).toBe(204);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBe(APP);
  expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  expect(r.headers.get("Access-Control-Allow-Headers").toLowerCase()).toContain("authorization");
  expect(r.headers.get("Access-Control-Allow-Headers").toLowerCase()).toContain("if-none-match");
  expect(r.headers.get("Vary")).toContain("Origin");
});

test("preflight from an unknown origin is refused without CORS headers", async () => {
  const r = await call("/v1/rows/pull", { method: "OPTIONS", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" } });
  expect(r.status).toBe(403);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("no configured origins means no CORS at all", async () => {
  const r = await call("/v1/rows/pull", { method: "OPTIONS", headers: { Origin: APP } }, env({ CORS_ORIGINS: undefined }));
  expect(r.status).toBe(403);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("an API response to a configured origin carries the origin and exposes ETag", async () => {
  const r = await call("/v1/catalog", { headers: { Origin: APP, Authorization: "Bearer test" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBe(APP);
  expect(r.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  expect(r.headers.get("ETag")).toBeTruthy();
});

test("auth failures still carry CORS headers so the app can read the 401", async () => {
  const r = await call("/v1/session", { headers: { Origin: APP, Authorization: "Bearer wrong" } });
  expect(r.status).toBe(401);
  expect(r.headers.get("Access-Control-Allow-Origin")).toBe(APP);
});

test("responses to other origins get no CORS headers", async () => {
  const r = await call("/v1/catalog", { headers: { Origin: "https://evil.test", Authorization: "Bearer test" } });
  expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("the Access-protected login pages never get CORS", async () => {
  const r = await call("/login", { method: "OPTIONS", headers: { Origin: APP } });
  expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test('the browser can read the server Date for the shared-core clock guard', async () => {
  const response = await worker.fetch(new Request('https://hub.test/v1/session', {
    headers: { Origin:'https://ui.test', Authorization:'Bearer test' },
  }), {HUB_TOKEN:'test',CORS_ORIGINS:'https://ui.test'}, {waitUntil(){}});
  expect(response.headers.get('Access-Control-Expose-Headers')?.split(',').map(s=>s.trim())).toContain('Date');
});

test('the browser can read Retry-After when a hub response asks it to wait', async () => {
  const response = await call('/v1/session', {
    headers: { Origin: APP, Authorization: 'Bearer test' },
  });
  expect(response.headers.get('Access-Control-Expose-Headers')?.split(',').map(s => s.trim())).toContain('Retry-After');
});

test('deployment delivers CORS origins from owning service configuration', async () => {
  const config = Bun.JSONC.parse(await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text());
  expect(config.vars).not.toHaveProperty('CORS_ORIGINS');
  const manifest = await Bun.file(new URL('../../.env.tpl', import.meta.url)).text();
  expect(manifest).toMatch(/^CORS_ORIGINS=op:\/\/Soma\/Soma ENV\/CORS_ORIGINS$/m);
  const workflow = await Bun.file(new URL('../../.github/workflows/deploy.yml', import.meta.url)).text();
  expect(workflow).toMatch(/^\s+CORS_ORIGINS: op:\/\/Soma\/Soma ENV\/CORS_ORIGINS$/m);
  const names = JSON.parse(workflow.match(/const names=(\[[^\]]+\])/)[1]);
  expect(names).toContain('CORS_ORIGINS');
});
