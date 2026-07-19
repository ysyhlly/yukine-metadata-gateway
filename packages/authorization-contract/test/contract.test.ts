import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import {
  AuthorizationContractError,
  authorizationSigningBytes,
  canonicalizeJson,
  randomNonce,
  signAuthorization,
  verifyAuthorization
} from "../src/index.js";

test("canonical JSON uses stable UTF-16 property order", () => {
  assert.equal(
    canonicalizeJson({ z: 1, a: "雪", nested: { two: false, one: true } }),
    '{"a":"雪","nested":{"one":true,"two":false},"z":1}'
  );
});

test("signs and verifies the frozen authorization envelope", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const nonce = randomNonce(randomBytes(32));
  const signed = signAuthorization({
    protocolVersion: "yukine-auth/v1",
    issuerId: "official-staging",
    subject: "subject-01",
    active: true,
    capabilities: ["together_listening", "official_metadata_gateway"],
    issuedAt: "2026-07-19T01:00:00.000Z",
    expiresAt: "2026-08-19T01:00:00.000Z",
    nonce
  }, privateKey, "key-2026-07");

  assert.deepEqual(signed.capabilities, [
    "official_metadata_gateway",
    "together_listening"
  ]);
  assert.ok(
    Buffer.from(authorizationSigningBytes(signed)).toString("utf8")
      .startsWith("yukine-auth/v1\n{")
  );
  assert.equal(
    verifyAuthorization(signed, {
      issuerId: "official-staging",
      nonce,
      publicKeys: new Map([["key-2026-07", publicKey]]),
      now: Date.parse("2026-07-19T01:00:10.000Z")
    }).subject,
    "subject-01"
  );
});

test("rejects a forged response and a replayed nonce", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const nonce = randomNonce(randomBytes(32));
  const signed = signAuthorization({
    protocolVersion: "yukine-auth/v1",
    issuerId: "official-staging",
    subject: "subject-01",
    active: true,
    capabilities: ["official_metadata_gateway"],
    issuedAt: "2026-07-19T01:00:00.000Z",
    expiresAt: "2026-08-19T01:00:00.000Z",
    nonce
  }, privateKey, "key-1");

  assert.throws(
    () => verifyAuthorization({ ...signed, active: false }, {
      issuerId: "official-staging",
      nonce,
      publicKeys: new Map([["key-1", publicKey]]),
      now: Date.parse("2026-07-19T01:00:10.000Z")
    }),
    (error) => error instanceof AuthorizationContractError
      && error.code === "invalid_signature"
  );
  assert.throws(
    () => verifyAuthorization(signed, {
      issuerId: "official-staging",
      nonce: randomNonce(randomBytes(32)),
      publicKeys: new Map([["key-1", publicKey]]),
      now: Date.parse("2026-07-19T01:00:10.000Z")
    }),
    (error) => error instanceof AuthorizationContractError
      && error.code === "nonce_mismatch"
  );
});
