import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  serverExternalPackages: ['openai', 'pdfkit'],
  experimental: {
    devtoolSegmentExplorer: false,
  },
};
export default nextConfig;
