import type { Metadata } from "next";
import { Karla, Syne } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { SecretGate } from "@/components/secret-gate";

const display = Syne({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
});

const body = Karla({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Linda — Personal AI Agent",
  description: "Asisten pribadi Linda: chat interaktif & pemantauan kuota Groq.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={`${display.variable} ${body.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <div className="app-ambient" aria-hidden="true" />
        <SecretGate>
          <div className="app-shell">
            <Sidebar />
            <main className="app-main">{children}</main>
          </div>
        </SecretGate>
      </body>
    </html>
  );
}
