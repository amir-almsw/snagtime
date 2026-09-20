import type { Metadata } from "next";
import { AccessibilityFocusManager } from "@/components/accessibility-focus";
import { ThemeToggle } from "@/components/theme-toggle";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: { default: "Dvision Studio", template: "%s · Dvision Studio" },
  description: "Precision cuts, grooming, and styling by appointment.",
  applicationName: "Dvision Studio",
  icons: { icon: "/icon.svg" },
  manifest: "/manifest.webmanifest",
  openGraph: { title: "Dvision Studio", description: "Precision cuts, grooming, and styling by appointment.", type: "website" },
};

// Runs before first paint so a returning visitor never sees a flash of the wrong appearance.
const themeScript = `(function(){try{var s=localStorage.getItem("dvision:theme");var d=s==="dark"||(s!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><head>
    {/* A stylesheet link rather than next/font: next/font downloads at build time, and this image is
        built on the VPS, so a font-CDN hiccup would fail a deploy instead of degrading a page. The
        lint rule below targets the pages router, where a document-level link was the wrong place;
        in the app router the root layout head is exactly the right place. */}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
    {/* eslint-disable-next-line @next/next/no-page-custom-font */}
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@300;400;500;600&family=Syne:wght@500;600;700&display=swap" />
  </head><body><script dangerouslySetInnerHTML={{ __html: themeScript }} /><AccessibilityFocusManager /><ThemeToggle />{children}</body></html>;
}
