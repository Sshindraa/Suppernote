import type { Metadata, Viewport } from 'next';
import { BRAND_SLOGAN, BRAND_TITLE } from '@suppernote/shared';
import { NextIntlClientProvider } from 'next-intl';
import { setRequestLocale, getMessages } from 'next-intl/server';
import { cookies } from 'next/headers';
import Providers from '@/components/providers';
import Header from '@/components/header';
import PwaInstallBanner from '@/components/PwaInstallBanner';
import { DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale, type Locale } from '@/i18n/config';
import { THEME_BOOTSTRAP } from '@/app/theme-bootstrap';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#030303',
};

export const metadata: Metadata = {
  title: `Suppernote — ${BRAND_TITLE}`,
  description: BRAND_SLOGAN,
  // Base absolue pour les canonical et Open Graph relatifs des pages marketing.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://suppernote.com'),
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Suppernote',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve locale from cookie (user's choice) or fall back to default
  const cookieStore = await cookies();
  const locale: Locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);

  // next-intl 4 : déclare la locale active au début du rendu pour que
  // `getTranslations` / `useTranslations` sachent où chercher.
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          id="suppernote-theme-bootstrap"
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }}
        />
      </head>
      <body className="min-h-screen bg-background antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <Header />
            <PwaInstallBanner />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
