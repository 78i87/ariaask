import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { enforceLocalApi, isLoopbackAddress, isLoopbackHostname } from "./local-security.js";

function runRequest(opts: {
  address?: string;
  hostname?: string;
  method?: string;
  headers?: Record<string, string>;
}): unknown {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const req = {
    socket: { remoteAddress: opts.address ?? "127.0.0.1" },
    hostname: opts.hostname ?? "localhost",
    method: opts.method ?? "GET",
    get: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Request;
  let result: unknown = "not-called";
  enforceLocalApi(req, {} as Response, ((err?: unknown) => {
    result = err ?? null;
  }) as NextFunction);
  return result;
}

test("loopback detection accepts IPv4, mapped IPv4, and IPv6 only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.15.2.3"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("192.168.1.4"), false);
  assert.equal(isLoopbackAddress("10.0.0.2"), false);
});

test("loopback hostname validation rejects DNS-rebinding hostnames", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("app.localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("attacker.example"), false);
});

test("safe local reads pass while LAN and hostile Host requests fail", () => {
  assert.equal(runRequest({}), null);
  assert.match(String(runRequest({ address: "192.168.1.4" })), /local machine/i);
  assert.match(String(runRequest({ hostname: "attacker.example" })), /loopback hostnames/i);
});

test("mutations require the local action header and reject cross-site metadata", () => {
  assert.match(String(runRequest({ method: "POST" })), /local action/i);
  assert.equal(runRequest({ method: "POST", headers: { "x-aria-local-action": "1" } }), null);
  assert.match(
    String(
      runRequest({
        method: "POST",
        headers: {
          "x-aria-local-action": "1",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    ),
    /cross-site/i,
  );
});
