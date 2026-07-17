import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteJsonCache } from "../src/node/sqlite-cache.js";

test("SQLite cache persists across reopen and stores only SHA-256 request keys", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "cache.sqlite");
  const secretUrl = "https://api.acoustid.org/v2/lookup?client=top-secret&fingerprint=private-print";
  const now = Date.now();
  const cache = new SqliteJsonCache({ path, ttlSeconds: 3_600, maxEntries: 10_000 });
  cache.put(secretUrl, JSON.stringify({ ok: true }), now);
  cache.close();

  const reopened = new SqliteJsonCache({ path, ttlSeconds: 3_600, maxEntries: 10_000 });
  assert.equal(reopened.get(secretUrl, now + 1_000), JSON.stringify({ ok: true }));
  reopened.close();

  const databaseBytes = readFileSync(path).toString("latin1");
  const walPath = `${path}-wal`;
  const walBytes = (() => {
    try {
      return readFileSync(walPath).toString("latin1");
    } catch {
      return "";
    }
  })();
  assert.doesNotMatch(databaseBytes + walBytes, /top-secret|private-print/);
});

test("SQLite cache honors TTL and cleans expired rows on reopen", async (context) => {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "cache.sqlite");
  const cache = new SqliteJsonCache({ path, ttlSeconds: 1, maxEntries: 10 });
  cache.put("https://example.com/old", "{}", 1_000);
  assert.equal(cache.get("https://example.com/old", 1_999), "{}");
  assert.equal(cache.get("https://example.com/old", 2_000), null);
  cache.close();

  const reopened = new SqliteJsonCache({ path, ttlSeconds: 1, maxEntries: 10 });
  assert.equal(reopened.get("https://example.com/old", Date.now()), null);
  reopened.close();
});

test("SQLite cache evicts least recently used rows every 100 writes", async (context) => {
  const directory = await temporaryDirectory(context);
  const cache = new SqliteJsonCache({
    path: join(directory, "cache.sqlite"),
    ttlSeconds: 3_600,
    maxEntries: 2
  });
  for (let index = 0; index < 100; index += 1) {
    cache.put(`https://example.com/${index}`, JSON.stringify({ index }), 1_000 + index);
  }

  assert.equal(cache.get("https://example.com/0", 2_000), null);
  assert.equal(cache.get("https://example.com/98", 2_000), JSON.stringify({ index: 98 }));
  assert.equal(cache.get("https://example.com/99", 2_000), JSON.stringify({ index: 99 }));
  cache.close();
});

test("corrupt or unusable database paths fail startup", async (context) => {
  const directory = await temporaryDirectory(context);
  const corrupt = join(directory, "corrupt.sqlite");
  writeFileSync(corrupt, "not a sqlite database", "utf8");
  assert.throws(
    () => new SqliteJsonCache({ path: corrupt, ttlSeconds: 1, maxEntries: 1 })
  );
  assert.throws(
    () => new SqliteJsonCache({ path: directory, ttlSeconds: 1, maxEntries: 1 })
  );
});

async function temporaryDirectory(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "yukine-gateway-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
