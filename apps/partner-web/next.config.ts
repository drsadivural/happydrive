import path from 'node:path';
import type { NextConfig } from 'next';
import { imageOriginsFromEnv, securityHeaders } from '@happydrive/web-ui/bff/security-headers';
import { resolveSecure } from '@happydrive/web-ui/bff/session';

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  transpilePackages: ['@happydrive/web-ui', '@happydrive/contracts', '@happydrive/design-tokens'],
  turbopack: { root: path.resolve(__dirname, '../..') },
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({ googleSignIn: true, isDev, https: !isDev && resolveSecure(), imageOrigins: imageOriginsFromEnv() }),
      },
    ];
  },
};

export default nextConfig;
