import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Signal — primary operating accent (deep flight-instrument indigo-blue).
        // Replaces the stock #0070f3 everywhere `primary` / `text-primary` /
        // `bg-primary` is already used across the app.
        primary: {
          DEFAULT: "#3B5BFF",
          foreground: "#ffffff",
          50: "#EEF1FF",
          100: "#DCE2FF",
          200: "#B9C6FF",
          300: "#8FA0FF",
          400: "#6178FF",
          500: "#3B5BFF",
          600: "#2A44E0",
          700: "#2135B3",
          800: "#1B2C8C",
          900: "#182566",
        },
        // Beacon — sparing amber signal used for "live" pulses, warnings, and
        // one-off highlight moments. Never used as a base surface color.
        beacon: {
          DEFAULT: "#FFB020",
          soft: "#FFF4DE",
        },
        // Ink — dedicated near-black navy surfaces for chrome (sidebar, app
        // shell) that sit a shade darker than card surfaces.
        ink: {
          950: "#090B10",
          900: "#0E1118",
          800: "#141822",
          700: "#1B202D",
        },
        // A cool, faintly blue-tinted neutral scale standing in for Tailwind's
        // default gray. Every existing `text-gray-500`, `border-gray-800`,
        // `bg-gray-900` class in the app inherits this automatically.
        gray: {
          50: "#F7F8FA",
          100: "#EEF1F5",
          200: "#E1E5EC",
          300: "#C7CCDA",
          400: "#9AA1B5",
          500: "#6E7690",
          600: "#4E5570",
          700: "#363C52",
          800: "#1E2230",
          900: "#141824",
          950: "#0B0D14",
        },
        card: {
          DEFAULT: "rgba(255, 255, 255, 0.9)",
          dark: "rgba(18, 21, 30, 0.92)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        // Tabular / telemetry face for metrics, timestamps, and other
        // instrument-panel readouts — the app's typographic signature.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "JetBrains Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        panel: "0 1px 2px rgba(11,13,20,0.04), 0 12px 32px -16px rgba(11,13,20,0.18)",
        "panel-dark": "0 1px 0 rgba(255,255,255,0.03) inset, 0 20px 40px -24px rgba(0,0,0,0.6)",
        glow: "0 0 0 1px rgba(59,91,255,0.15), 0 0 24px -4px rgba(59,91,255,0.35)",
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        beacon: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(1.15)" },
        },
        "beacon-ring": {
          "0%": { transform: "scale(1)", opacity: "0.55" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        beacon: "beacon 2.2s ease-in-out infinite",
        "beacon-ring": "beacon-ring 2.2s cubic-bezier(0.2,0.6,0.4,1) infinite",
        "fade-up": "fade-up 0.35s ease-out both",
      },
    },
  },
  plugins: [],
};
export default config;
