import { Logo } from "@/components/Nav";

export const dynamic = "force-dynamic";

/** Where Self sends a person after their passport check. Nothing about them is shown or kept here. */
export default async function PassportDone({ searchParams }: { searchParams: Promise<{ failed?: string }> }) {
  const failed = (await searchParams).failed;
  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="mb-6"><Logo /></div>
      <div className="card">
        <h1>{failed ? "The passport check did not finish" : "Thank you, the check is done"}</h1>
        <p className="mt-2" style={{ color: "var(--tx-1)" }}>
          {failed
            ? "Nothing was shared. You can open the link again, or ask the business for a new one."
            : "Your passport proved what was asked (a real passport holder, of age, not on sanctions lists) without sharing your name, number or any document. You can close this page."}
        </p>
      </div>
    </div>
  );
}
