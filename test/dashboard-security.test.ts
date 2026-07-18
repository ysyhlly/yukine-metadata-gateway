import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncGate,
  AttemptLimiter,
  clearSessionCookie,
  hashPassword,
  normalizeUsername,
  sessionCookie,
  validatePassword,
  verifyPassword,
  WorkQueueBusyError
} from "../src/node/dashboard-security.js";

test("dashboard credentials use normalized usernames and bounded passwords", () => {
  assert.equal(normalizeUsername("  雪音.admin  "), "雪音.admin");
  assert.equal(normalizeUsername("ab"), null);
  assert.equal(normalizeUsername("admin name"), null);
  assert.equal(validatePassword("short"), null);
  assert.equal(validatePassword("正确马长亭-2026"), "正确马长亭-2026");
  assert.equal(validatePassword("x".repeat(257)), null);
});

test("dashboard passwords use salted scrypt hashes", async () => {
  const password = "high-entropy-test-password";
  const first = await hashPassword(password, { logN: 12 });
  const second = await hashPassword(password, { logN: 12 });
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /high-entropy/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong-password-value", first), false);
});

test("dashboard session cookie is host-only, secure, HttpOnly and strict", () => {
  const cookie = sessionCookie("token", 3_600);
  assert.match(cookie, /^__Host-yukine_gateway_session=token;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test("password work queue is bounded and transfers permits", async () => {
  const gate = new AsyncGate(1, 1, 1_000);
  let releaseFirst!: () => void;
  const first = gate.run(() => new Promise<number>((resolve) => {
    releaseFirst = () => resolve(1);
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = gate.run(async () => 2);
  await assert.rejects(
    gate.run(async () => 3),
    (error: unknown) => error instanceof WorkQueueBusyError
  );
  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});

test("attempt limiter bounds retained source keys", () => {
  const limiter = new AttemptLimiter(2, 60_000, 2);
  assert.equal(limiter.check("a", 1_000).allowed, true);
  assert.equal(limiter.check("b", 1_000).allowed, true);
  assert.equal(limiter.check("c", 1_000).allowed, true);
  const retained = (limiter as unknown as {
    attempts: Map<string, unknown>;
  }).attempts;
  assert.equal(retained.size, 2);
});
