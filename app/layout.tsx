import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./globals.css";
import "./auth.css";
export const metadata: Metadata = {
  title: "Chainlab — Prompt chain studio",
  description:
    "Connect prompts. Shape ideas. Create something extraordinary. Your private prompt chain studio.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
