// eslint.config.js
export default [
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
