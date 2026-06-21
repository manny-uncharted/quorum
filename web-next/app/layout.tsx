import type { Metadata } from "next";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

export const metadata: Metadata = {
  title: "Quorum — Autonomous Multi-Agent Prediction Desk",
  description: "An AI prediction desk on Sui's DeepBook Predict that debates consensus and publishes it on-chain as a reusable wisdom-of-agents oracle.",
  keywords: ["Sui", "DeepBook", "Predict", "AI Agents", "Consensus Oracle", "Binary Options", "Kelly Criterion"],
  openGraph: {
    title: "Quorum — Autonomous Multi-Agent Prediction Desk",
    description: "Debates consensus and publishes it on-chain as a reusable wisdom-of-agents oracle.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${outfit.variable}`}>
      <body>{children}</body>
    </html>
  );
}
