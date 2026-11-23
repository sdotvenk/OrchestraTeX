import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { ExternalLinkHandler } from "@/components/external-link-handler";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
});

const displaySerif = Newsreader({
  variable: "--font-display-serif",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "OrchestraTeX",
  description: "Local-first multi-provider AI agent & live LaTeX workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${plexSans.variable} ${plexMono.variable} ${displaySerif.variable} antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange>
          <ToastProvider>
            <ExternalLinkHandler />
            {children}
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
