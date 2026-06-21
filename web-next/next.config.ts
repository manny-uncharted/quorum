import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "../web",
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8787/api/:path*",
      },
    ];
  },
};

export default nextConfig;
