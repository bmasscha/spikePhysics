/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // High-contrast palette tuned for harsh sports-hall lighting.
        court: {
          bg: "#020617",
          panel: "#0f172a",
          line: "#1e293b",
        },
        signal: {
          ok: "#22c55e",
          warn: "#f59e0b",
          danger: "#ef4444",
          accent: "#22d3ee",
        },
      },
      minHeight: {
        tap: "48px",
      },
      minWidth: {
        tap: "48px",
      },
    },
  },
  plugins: [],
};
