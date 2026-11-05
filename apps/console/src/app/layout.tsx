import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// UI and data use the platform faces (SF Pro and SF Mono on Apple devices), so the console
// downloads no UI font. The honesty strip keeps its shared face.
const strip = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-strip",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Imperium: the human control plane for autonomous systems",
  description:
    "Humans set intent. Autonomy executes. A simulated search and rescue mission with fictional assets, replayed from real runs of the sim and control plane.",
};

export const viewport: Viewport = { themeColor: "#05070a", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={strip.variable}>
      <body>{children}</body>
    </html>
  );
}
