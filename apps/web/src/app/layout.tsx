import type { Metadata } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import { AppShell } from '../components/app-shell';
import { buttonClass } from '../components/ui';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const interTight = Inter_Tight({ subsets: ['latin'], variable: '--font-inter-tight', display: 'swap' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Talon',
  description: 'Hiring, coordinated.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`}>
      <body>
        <a href="#main" className={buttonClass('secondary', 'sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-modal)]')}>
          Skip to content
        </a>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
