import type { NextConfig } from "next";

// Static export → out/ for Cloudflare Pages. All data fetching is client-side
// against the Hono Worker (NEXT_PUBLIC_API_URL), so no server runtime is needed.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
