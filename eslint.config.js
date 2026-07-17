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
        // Chrome extension APIs
        chrome: "readonly",
        // Classic-script vendored libs (loaded via <script> on some pages)
        d3: "readonly",
        lunr: "readonly",
        // Browser globals — no-undef needs an explicit list under flat config
        console: "readonly",
        window: "readonly",
        document: "readonly",
        self: "readonly",
        navigator: "readonly",
        location: "readonly",
        history: "readonly",
        screen: "readonly",
        devicePixelRatio: "readonly",
        innerWidth: "readonly",
        innerHeight: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        AbortController: "readonly",
        Image: "readonly",
        Audio: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        performance: "readonly",
        PerformanceObserver: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        alert: "readonly",
        confirm: "readonly",
        getComputedStyle: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        DOMParser: "readonly",
        XMLSerializer: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        HTMLElement: "readonly",
        Node: "readonly",
        NodeFilter: "readonly",
      }
    },
    rules: {
      "semi": ["error", "always"],
      "quotes": ["error", "double"],
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }], // Warn on unused vars, ignore if prefixed with _
      "no-undef": "error",
    }
  }
];
