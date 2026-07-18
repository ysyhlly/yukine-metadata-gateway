import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual
} from "node:crypto";

export interface PasswordHashOptions {
  logN?: number;
  r?: number;
  p?: number;
  keyLength?: number;
}

const DEFAULT_LOG_N = 17;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEY_LENGTH = 32;

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFKC");
  if (normalized.length < 3 || normalized.length > 64) return null;
  return /^[\p{L}\p{N}_.-]+$/u.test(normalized) ? normalized : null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 12 && bytes <= 256 ? value : null;
}

export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {}
): Promise<string> {
  const logN = options.logN ?? DEFAULT_LOG_N;
  const r = options.r ?? DEFAULT_R;
  const p = options.p ?? DEFAULT_P;
  const keyLength = options.keyLength ?? DEFAULT_KEY_LENGTH;
  const salt = randomBytes(16);
  const derived = await derive(password, salt, logN, r, p, keyLength);
  return [
    "scrypt",
    "v=1",
    `ln=${logN},r=${r},p=${p}`,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const derived = await derive(
    password,
    parsed.salt,
    parsed.logN,
    parsed.r,
    parsed.p,
    parsed.hash.length
  );
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export const SESSION_COOKIE_NAME = "__Host-yukine_gateway_session";

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "Secure",
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ");
}

export function clearSessionCookie(): string {
  return sessionCookie("", 0);
}

export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private checks = 0;

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly maximumKeys = 10_000
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.checks += 1;
    if (this.checks % 256 === 0) this.cleanup(now);
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.attempts.size >= this.maximumKeys) this.evictOne(now);
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count = Math.min(this.maximum + 1, current.count + 1);
    if (current.count <= this.maximum) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000))
    };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private cleanup(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(key);
    }
  }

  private evictOne(now: number): void {
    this.cleanup(now);
    if (this.attempts.size < this.maximumKeys) return;
    let oldestKey: string | undefined;
    let oldestReset = Number.POSITIVE_INFINITY;
    for (const [key, attempt] of this.attempts) {
      if (attempt.resetAt < oldestReset) {
        oldestKey = key;
        oldestReset = attempt.resetAt;
      }
    }
    if (oldestKey) this.attempts.delete(oldestKey);
  }
}

export class WorkQueueBusyError extends Error {
  constructor() {
    super("work_queue_busy");
  }
}

export class AsyncGate {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (error: WorkQueueBusyError) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maximumQueue = 16,
    private readonly waitTimeoutMs = 3_000
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= this.maximumQueue) throw new WorkQueueBusyError();
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new WorkQueueBusyError());
        }, this.waitTimeoutMs)
      };
      waiter.timer.unref();
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

interface ParsedPasswordHash {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const [algorithm, version, parameters, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || version !== "v=1" || !parameters || !saltText || !hashText) {
    return null;
  }
  const values = new Map(
    parameters.split(",").map((part) => {
      const [name, value] = part.split("=");
      return [name, Number.parseInt(value || "", 10)] as const;
    })
  );
  const logN = values.get("ln");
  const r = values.get("r");
  const p = values.get("p");
  if (
    !logN || logN < 10 || logN > 17
    || !r || r < 1 || r > 8
    || !p || p < 1 || p > 2
  ) {
    return null;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const hash = Buffer.from(hashText, "base64url");
    if (salt.length < 16 || hash.length < 16 || hash.length > 128) return null;
    return { logN, r, p, salt, hash };
  } catch {
    return null;
  }
}

function derive(
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
  keyLength: number
): Promise<Buffer> {
  const N = 2 ** logN;
  const maxmem = Math.max(256 * 1024 * 1024, 128 * N * r + 32 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, { N, r, p, maxmem }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}
