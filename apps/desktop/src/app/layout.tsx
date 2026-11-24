import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { ExternalLinkHandler } from "@/components/external-link-handler";
import { ToastProvider } from "@/components/ui/toast";
import {
  APPEARANCE_CLASSES,
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_THEMES,
} from "@/lib/editor/appearance";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const displaySerif = Instrument_Serif({
  variable: "--font-display-serif",
  subsets: ["latin"],
  display: "swap",
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "OrchestraTeX",
  description: "Local-first multi-provider AI agent & live LaTeX workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${displaySerif.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          storageKey={APPEARANCE_STORAGE_KEY}
          themes={APPEARANCE_THEMES}
          value={APPEARANCE_CLASSES}
          enableColorScheme={false}
          disableTransitionOnChange
        >
          <ToastProvider>
            <ExternalLinkHandler />
            {children}
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
