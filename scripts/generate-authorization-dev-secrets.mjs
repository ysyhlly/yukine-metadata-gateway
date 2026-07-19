import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("secrets");
mkdirSync(output, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
writeSecret("gateway-signing-private.pem", privatePem);
writeSecret("gateway-signing-public.pem", publicPem);
writeSecret("gateway-credential-pepper", randomBytes(32));
writeSecret("cloud-kek", randomBytes(32));
writeSecret("dashboard-setup-token", randomBytes(32).toString("base64url"));
writeSecret("cloud-postgres-password", randomBytes(24).toString("base64url"));
const issuer = {
  issuerId: "official-local",
  displayName: "YUKINE Local Trusted Gateway",
  origin: process.env.DEV_GATEWAY_ORIGIN
    || "http://metadata-gateway-authorized:8787",
  verifyPath: "/v1/authorization/verify",
  redeemPathPrefix: "/v1/authorization/redeem/",
  activatePath: "/v1/authorization/activate",
  capabilities: [
    "official_metadata_gateway",
    "together_listening"
  ],
  publicKeys: {
    "local-1": publicPem
  },
  timeoutMs: 3000,
  maxResponseBytes: 65536,
  enabled: true,
  allowPrivateForTests: true
};
writeSecret("trusted-issuer.local.json", `${JSON.stringify(issuer, null, 2)}\n`);
process.stdout.write(`authorization development secrets written to ${output}\n`);

function writeSecret(name, value) {
  writeFileSync(resolve(output, name), value, { mode: 0o600 });
}
