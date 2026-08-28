import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './portal.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'OrthoVault — Shared aerial survey maps',
  description: 'Explore and share orthomosaic survey maps in a focused WebGIS portal.',
  openGraph: { title: 'OrthoVault — Shared aerial survey maps', description: 'Explore and share orthomosaic survey maps in a focused WebGIS portal.', images: ['/og.png'] },
  twitter: { card: 'summary_large_image', title: 'OrthoVault — Shared aerial survey maps', description: 'Explore and share orthomosaic survey maps in a focused WebGIS portal.', images: ['/og.png'] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
