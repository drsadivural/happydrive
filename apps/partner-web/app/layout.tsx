import type { Metadata, Viewport } from 'next';
import { Noto_Sans_JP } from 'next/font/google';
import '@happydrive/design-tokens/tokens.css';
import '@happydrive/web-ui/styles.css';

const noto = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-noto-sans-jp',
});

export const metadata: Metadata = {
  title: { default: 'HappyDrive 暮らしの支援', template: '%s | HappyDrive' },
  description: '訪問・配送・生活支援の依頼と供給者の業務をつなぐ HappyDrive',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0B1F4B' },
    { media: '(prefers-color-scheme: dark)', color: '#0A1733' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={noto.variable}>
      <body>{children}</body>
    </html>
  );
}
