import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the client runs on :5179 and talks to the server on :3009.
export default defineConfig({
  // Relative asset URLs: the app may be served under a path (venue.example.com/music/).
  base: "./",
  plugins: [react()],
  server: {
    host: true,
    port: 5179,
    proxy: {
      "/api": "http://localhost:3009",
      "/art": "http://localhost:3009",
      "/speaker-audio": "http://localhost:3009",
      "/__bargames": "http://localhost:3009",
      "/socket.io": { target: "http://localhost:3009", ws: true },
    },
  },
});
