import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// relative base so the build works on GitHub Pages (/Qill-Switch/) or any static host
export default defineConfig({ plugins: [react()], base: "./", server: { host: "127.0.0.1", port: 5174 } });
