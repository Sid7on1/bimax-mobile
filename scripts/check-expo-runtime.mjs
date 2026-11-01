import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobile = createRequire(path.join(root, "apps/mobile/package.json"));
const workspace = createRequire(path.join(root, "package.json"));
const expoPackage = mobile.resolve("expo/package.json");
const expo = JSON.parse(readFileSync(expoPackage, "utf8"));
assert.equal(
  Number(expo.version.split(".")[0]),
  58,
  "Phone project must match the supported SDK-58 Expo Go runtime",
);
const expected = JSON.parse(
  readFileSync(path.join(path.dirname(expoPackage), "bundledNativeModules.json"), "utf8"),
);
const resolved = {};
// Inspect resolved packages, not just app manifest ranges: workspace overrides can silently
// install SDK-57 native bindings even after Expo reports that manifest alignment succeeded.
for (const name of ["react", "react-native", "react-native-reanimated", "react-native-worklets", "react-native-webview"]) {
  const actual = mobile(name + "/package.json").version;
  assert.equal(actual, expected[name], `${name}: resolved native/JS runtime must match Expo Go`);
  for (const resolveFrom of [workspace, createRequire(expoPackage)])
    assert.equal(
      resolveFrom(name + "/package.json").version,
      expected[name],
      `${name}: workspace/Expo must resolve the same native runtime`,
    );
  resolved[name] = actual;
}
console.log(JSON.stringify({ sdk: 58, expo: expo.version, resolved, nativeRuntimeAligned: true }));
