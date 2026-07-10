import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedLocalUpdate, isDirectLoopbackRequest, isLoopbackAddress } from "./codex.js";

test("recognizes loopback addresses and rejects remote addresses", () => {
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("local maintenance rejects forwarded and non-local-host requests", () => {
  const request = (
    address: string,
    host: string,
    header: string | undefined,
    contentType: string | false,
    forwarded?: string,
  ) =>
    ({
      socket: { remoteAddress: address },
      headers: { host, "x-aria-local-action": header, "x-forwarded-for": forwarded },
      is: () => contentType,
    }) as unknown as Parameters<typeof isAuthorizedLocalUpdate>[0];

  assert.equal(isDirectLoopbackRequest(request("::1", "localhost:5275", undefined, false)), true);
  assert.equal(isDirectLoopbackRequest(request("::1", "example.com", undefined, false)), false);
  assert.equal(isDirectLoopbackRequest(request("::1", "localhost:5275", undefined, false, "203.0.113.8")), false);
  assert.equal(isAuthorizedLocalUpdate(request("::1", "localhost:5173", "codex-update", "application/json")), true);
  assert.equal(isAuthorizedLocalUpdate(request("::1", "localhost:5173", undefined, "application/json")), false);
  assert.equal(isAuthorizedLocalUpdate(request("::1", "localhost:5173", "codex-update", false)), false);
  assert.equal(isAuthorizedLocalUpdate(request("10.0.0.2", "localhost:5173", "codex-update", "application/json")), false);
});
