import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The browser talks to one origin only. Vite forwards each path to the service
 * behind it, so nothing needs CORS and no service is exposed to the browser
 * under its own address. Targets are the Compose service names; each can be
 * overridden for running outside Compose.
 */
const upstream = (variable: string, fallback: string) => process.env[variable] ?? fallback;
const strip = (prefix: string) => (path: string) => path.slice(prefix.length) || "/";

export default defineConfig({
    plugins: [react()],
    server: {
        host: "0.0.0.0",
        port: 5173,
        strictPort: true,
        // Vite refuses unknown Host headers, against DNS rebinding. The demo is
        // reached as localhost from the host and as "web" from inside its
        // network, where the end-to-end tests run.
        allowedHosts: ["localhost", "web"],
        // The shared package lives outside web/, and the app imports it.
        fs: { allow: [".."] },
        proxy: {
            "/api": { target: upstream("WEB_API_URL", "http://api:3000") },
            "/chain": { target: upstream("WEB_CHAIN_URL", "http://anvil:8545"), rewrite: strip("/chain") },
            "/bundler": { target: upstream("WEB_BUNDLER_URL", "http://bundler:4337"), rewrite: strip("/bundler") },
            "/paymaster": { target: upstream("WEB_PAYMASTER_URL", "http://paymaster:4338"), rewrite: strip("/paymaster") },
        },
    },
});
