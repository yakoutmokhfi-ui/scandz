import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        espresso: "#221510",
        crema: "#F6F2EC",
        caramel: "#A96A2D",
        "caramel-dark": "#8A5322",
        gold: "#C6A15B",
      },
    },
  },
  plugins: [],
};

export default config;
