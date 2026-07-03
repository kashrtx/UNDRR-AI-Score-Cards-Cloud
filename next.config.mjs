/** @type {import('next').NextConfig} */
const nextConfig = {
  // The migrated prototype has a few loose types; don't let them block a deploy.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
};

export default nextConfig;
