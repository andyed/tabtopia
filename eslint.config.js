// eslint.config.js
export default [
  {
    // Vendored third-party libraries — never lint or --fix these. A repo-wide
    // eslint --fix once rewrote d3.min.js/lunr.min.js (semicolon insertion
    // across 280KB of minified code), destroying upstream provenance.
    ignores: ["src/lib/**", "node_modules/**", "test-results/**"],
  },
  {
    languageOptions: {
      ecmaVersion: 2022, // or a more recent version if you use newer syntax
      sourceType: "module", // common for modern JS
      globals: {
        chrome: "readonly", // for Chrome extension APIs
        console: "readonly",
        // Add other globals if needed (e.g., for specific libraries)
      }
    },
    rules: {
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }], // Warn on unused vars, ignore if prefixed with _
      // Add or customize rules as needed
    }
  }
];
