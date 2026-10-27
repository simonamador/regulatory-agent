import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Fail-closed boundaries (SPEC §6): the only files allowed to catch errors.
const boundaries = ["apps/api/src/llm.ts", "packages/core/src/corpus.ts"];

export default tseslint.config(
  { ignores: ["**/dist/**", "runs/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      complexity: ["error", 8],
      "max-depth": ["error", 3],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "no-restricted-syntax": [
        "error",
        { selector: "TryStatement", message: "Fail closed: try/catch only at SPEC §6 boundaries." },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "z3-solver", message: "Z3 lives only in packages/core/src/{encode,checks}.ts." },
            { name: "openai", message: "OpenAI lives only in apps/api/src/llm.ts." },
          ],
        },
      ],
    },
  },
  { files: boundaries, rules: { "no-restricted-syntax": "off" } },
  {
    files: ["packages/core/src/encode.ts", "packages/core/src/checks.ts", "apps/api/src/llm.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
