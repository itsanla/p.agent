import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { SecretGate } from "@/components/secret-gate";

export const metadata: Metadata = {
  title: "Linda — Personal AI Agent",
  description: "Asisten pribadi Linda: chat interaktif & pemantauan kuota Groq.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className="h-full antialiased">
      <body className="min-h-full">
        <SecretGate>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar />
            <main className="flex-1 overflow-x-hidden">{children}</main>
          </div>
        </SecretGate>
      </body>
    </html>
  );
}
