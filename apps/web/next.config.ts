import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sidequest/bench', '@sidequest/core', '@sidequest/geo', '@sidequest/planner'],
  serverExternalPackages: ['better-sqlite3'],
  typedRoutes: false,
};

export default nextConfig;
