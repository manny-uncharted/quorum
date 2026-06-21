import type { NextConfig } from "next";

const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL;
const backendUrl = process.env.QUORUM_BACKEND_URL || "http://localhost:8787";

const nextConfig: NextConfig = {
  // Only use static export when NOT on Vercel (so local builds for Bun serve work)
  ...(isVercel ? {} : { output: "export", distDir: "../web" }),
  
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
