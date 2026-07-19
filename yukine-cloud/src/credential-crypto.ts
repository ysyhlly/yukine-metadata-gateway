import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { EncryptedCredential } from "./types.js";

const WRAP_AAD = Buffer.from("yukine-cloud-kek/v1", "utf8");

export interface KekProvider {
  readonly keyId: string;
  wrap(dek: Uint8Array): Promise<{
    ciphertext: Uint8Array;
    iv: Uint8Array;
    tag: Uint8Array;
  }>;
  unwrap(input: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
    tag: Uint8Array;
  }): Promise<Uint8Array>;
}

export class FileKekProvider implements KekProvider {
  private readonly key: Buffer;

  constructor(readonly keyId: string, path: string) {
    this.key = readKey32(path);
  }

  async wrap(dek: Uint8Array) {
    return aesGcmEncrypt(this.key, Buffer.from(dek), WRAP_AAD);
  }

  async unwrap(input: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
    tag: Uint8Array;
  }): Promise<Uint8Array> {
    return aesGcmDecrypt(
      this.key,
      Buffer.from(input.ciphertext),
      Buffer.from(input.iv),
      Buffer.from(input.tag),
      WRAP_AAD
    );
  }
}

export class CredentialEnvelope {
  constructor(private readonly kek: KekProvider) {}

  async encrypt(
    plaintext: string,
    context: { userId: string; issuerId: string; version: number }
  ): Promise<EncryptedCredential> {
    const dek = randomBytes(32);
    const aad = credentialAad(context);
    const encrypted = aesGcmEncrypt(dek, Buffer.from(plaintext, "utf8"), aad);
    const wrapped = await this.kek.wrap(dek);
    dek.fill(0);
    return {
      version: 1,
      keyId: this.kek.keyId,
      iv: encode(encrypted.iv),
      ciphertext: encode(encrypted.ciphertext),
      tag: encode(encrypted.tag),
      wrappedDek: encode(wrapped.ciphertext),
      wrapIv: encode(wrapped.iv),
      wrapTag: encode(wrapped.tag)
    };
  }

  async decrypt(
    encrypted: EncryptedCredential,
    context: { userId: string; issuerId: string; version: number }
  ): Promise<string> {
    if (encrypted.version !== 1 || encrypted.keyId !== this.kek.keyId) {
      throw new Error("unsupported_credential_envelope");
    }
    const dek = Buffer.from(await this.kek.unwrap({
      ciphertext: decode(encrypted.wrappedDek),
      iv: decode(encrypted.wrapIv),
      tag: decode(encrypted.wrapTag)
    }));
    try {
      return aesGcmDecrypt(
        dek,
        decode(encrypted.ciphertext),
        decode(encrypted.iv),
        decode(encrypted.tag),
        credentialAad(context)
      ).toString("utf8");
    } finally {
      dek.fill(0);
    }
  }
}

function credentialAad(context: {
  userId: string;
  issuerId: string;
  version: number;
}): Buffer {
  return Buffer.from(
    `yukine-cloud-credential/v1\n${context.userId}\n${context.issuerId}\n${context.version}`,
    "utf8"
  );
}

function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer
): { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag()
  };
}

function aesGcmDecrypt(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  aad: Buffer
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function readKey32(path: string): Buffer {
  const raw = readFileSync(path);
  if (raw.byteLength === 32) return Buffer.from(raw);
  const text = raw.toString("utf8").trim();
  if (/^[a-fA-F0-9]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) {
    const decoded = Buffer.from(text, "base64url");
    if (decoded.byteLength === 32) return decoded;
  }
  throw new Error("cloud_kek_must_be_32_bytes");
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
