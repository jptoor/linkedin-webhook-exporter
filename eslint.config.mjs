import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "dist-test/**", "node_modules/**", "test-results/**", "playwright-report/**", "*.zip"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: "readonly", __EXTENSION_VERSION__: "readonly", __TEST_BUILD__: "readonly", __LWE_DEBUG__: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off"
    }
  },
  { files: ["receiver/**/*.mjs", "scripts/**/*.mjs", "tests/fixtures/*.mjs"], rules: { "@typescript-eslint/no-require-imports": "off" } }
);
