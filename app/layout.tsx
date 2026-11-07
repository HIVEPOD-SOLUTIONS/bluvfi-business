import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { Toaster } from "@/components/Toast";
import { Logo } from "@/components/Nav";
import { NETWORK, SIGNER_NAMES } from "@/lib/config";
import { ModeSwitch } from "@/components/ModeSwitch";
import { isOwner } from "@/lib/team";
import { DEFAULT_BIZ, modeOf, runAs } from "@/lib/tenant";
import { currentSession } from "@/lib/who";
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
  const session = await currentSession();
  const signer = session?.name;
  const demo = (session ? modeOf(session.biz) : modeOf(DEFAULT_BIZ)) === "demo";
  const owner = !!session && runAs(session.biz, () => isOwner(session.name));
  return (
    <html lang="en" className={`${dmSans.variable} ${spaceMono.variable} h-full antialiased`}>
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before React loads; ignore only those. */}
      <body className="min-h-full" suppressHydrationWarning>
        {demo && (
          <div role="status" className="flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-center text-sm md:pl-60" style={{ background: "rgba(201,168,76,.16)", color: "#e9d48f" }}>
            <span>Demo mode: fictional invoices, AI reviews replayed from fixtures, and a simulated DAO. No keys, no funds. Every signature is still checked.</span>
            {signer && <ModeSwitch mode="demo" owner={owner} wide />}
          </div>
        )}
        {signer ? (
          <>
            <Nav signer={signer} demo={demo} owner={owner} business={session?.bizName} network={NETWORK} operator={session?.biz === DEFAULT_BIZ && SIGNER_NAMES.includes(signer)} />
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
        <Toaster />
      </body>
    </html>
  );
}
