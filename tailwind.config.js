/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        // Two-column layout is only appropriate when in landscape AND we have enough
        // vertical height to show the video and charts side-by-side.
        // - Pure 'landscape' will force two columns on a phone (e.g., 844x390), squishing them.
        // - Pure width 'lg:' (1024px) will force two columns on a large portrait tablet (1024x1366).
        // Using both orientation and a minimum height of 600px perfectly targets tablets in landscape.
        split: { raw: "(orientation: landscape) and (min-height: 600px)" },
      },
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
