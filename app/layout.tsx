import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNDRR ARISE Scorecard Analyzer",
  description:
    "Analyze a city's UNDRR Disaster Resilience Scorecard and generate a grounded, prioritized action plan — entirely in your browser.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
    apple: [{ url: "/favicon.svg" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f1a",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
