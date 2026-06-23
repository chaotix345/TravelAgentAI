import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TravelAgentAI",
  description: "Tell it what you want out of a trip. It hands you one decisive plan.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
