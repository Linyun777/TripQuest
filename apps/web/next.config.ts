import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// The workspace keeps one local .env beside compose.yaml, two levels above apps/web.
const workspaceEnv = resolve(process.cwd(), "../../.env");
if (existsSync(workspaceEnv)) process.loadEnvFile(workspaceEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pnpm dev:https` (phone testing) sets this to the computer's LAN addresses.
  ...(process.env.TRIPQUEST_DEV_ORIGINS ? { allowedDevOrigins: process.env.TRIPQUEST_DEV_ORIGINS.split(",") } : {}),
  // Next 16 logs Server Function arguments by default, including selected POI coordinates.
  // Keep operation request logs, but never emit action payloads or enable full fetch URLs.
  logging: { serverFunctions: false },
  transpilePackages: [
    "@tripquest/agent",
    "@tripquest/application",
    "@tripquest/auth",
    "@tripquest/db",
    "@tripquest/domain",
    "@tripquest/providers",
    "@tripquest/rag",
  ],
};

export default nextConfig;
