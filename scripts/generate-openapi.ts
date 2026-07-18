import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openapiDocument } from "../src/contracts/openapi.js";

const path = resolve("openapi.json");
const output = `${JSON.stringify(openapiDocument, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // A missing document is reported as drift below.
  }
  if (existing !== output) {
    process.stderr.write("openapi.json is out of date; run npm run generate:openapi\n");
    process.exitCode = 1;
  }
} else {
  writeFileSync(path, output, "utf8");
}
