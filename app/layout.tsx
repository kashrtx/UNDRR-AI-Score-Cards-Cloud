import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata: Metadata = {
  title: "UNDRR ARISE Scorecard Analyzer",
  description:
    "Analyze a city's UNDRR Disaster Resilience Scorecard and get a grounded, prioritized action plan, right in your browser.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
    apple: [{ url: "/favicon.svg" }],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

// Apply the saved theme before paint so there's no flash. Default is light.
const themeScript = `try{var t=localStorage.getItem('undrr.theme')||'light';if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased"><ErrorBoundary>{children}</ErrorBoundary></body>
    </html>
  );
}
