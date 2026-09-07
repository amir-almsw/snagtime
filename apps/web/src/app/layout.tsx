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
  return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: themeScript }} /><AccessibilityFocusManager /><ThemeToggle />{children}</body></html>;
}
