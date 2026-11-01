import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { Logo } from "@/components/Nav";
import { DEMO } from "@/lib/config";
import { currentSigner } from "@/lib/who";
import Link from "next/link";
import "./globals.css";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const spaceMono = Space_Mono({ variable: "--font-space-mono", subsets: ["latin"], weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Bluvfi Business — verifiable trust for agent payments",
  description:
    "Before any AI agent moves money, Bluvfi Business checks the counterparty, enforces human-set policy, verifies the AI's signed judgment and leaves evidence an auditor can check.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const signer = await currentSigner();
  return (
    <html lang="en" className={`${dmSans.variable} ${spaceMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {DEMO && (
          <div role="status" className="px-4 py-2 text-center text-sm md:pl-60" style={{ background: "rgba(201,168,76,.16)", color: "#e9d48f" }}>
            Demo mode: fictional invoices, AI reviews replayed from fixtures, and a simulated DAO. No keys, no funds. Every signature is still checked.
          </div>
        )}
        {signer ? (
          <>
            <Nav signer={signer} demo={DEMO} />
            <main className="md:pl-60 pb-24 md:pb-10">
              <div className="mx-auto max-w-5xl px-4 md:px-8 pt-6 md:pt-10">{children}</div>
            </main>
          </>
        ) : (
          <main className="pb-10">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 md:px-8 pt-5">
              <Link href="/"><Logo /></Link>
              <Link href="/login" className="btn btn-secondary btn-sm">Sign in</Link>
            </div>
            <div className="mx-auto max-w-5xl px-4 md:px-8 pt-6 md:pt-10">{children}</div>
          </main>
        )}
      </body>
    </html>
  );
}
