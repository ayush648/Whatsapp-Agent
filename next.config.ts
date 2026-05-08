import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["2eab-119-252-197-173.ngrok-free.app"],
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
