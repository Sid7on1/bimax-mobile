import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const { benchmarkPqPairing } = require("@bimax/core/crypto/benchmark");
const [iterations = "100", output] = process.argv.slice(2);
const result = {
  runtime: process.version,
  cpu: os.cpus()[0]?.model,
  platform: process.platform,
  arch: process.arch,
  recordedAt: new Date().toISOString(),
  ...benchmarkPqPairing(Number(iterations)),
};
const json = JSON.stringify(result, null, 2) + "\n";
if (output) fs.writeFileSync(output, json);
console.log(json);
