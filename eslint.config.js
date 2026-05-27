import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "curly": ["error", "all"],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "indent": ["error", 2, { SwitchCase: 1 }],
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
