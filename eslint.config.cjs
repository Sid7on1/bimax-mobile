const { defineConfig } = require("eslint/config");
const expo = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expo,
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "artifacts/audit/**",
      "**/node_modules/**",
      "packages/core/*.js",
      "packages/core/*.d.ts",
      "packages/core/crypto/**",
      "packages/core/e2e/**",
      "packages/core/session/**",
      "packages/core/relay/**",
    ],
  },
]);
