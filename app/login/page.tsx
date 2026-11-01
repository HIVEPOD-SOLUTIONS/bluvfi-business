import { Logo } from "@/components/Nav";
import { SIGNERS } from "@/lib/config";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default function Login() {
  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="mb-6"><Logo /></div>
      <div className="card">
        <h1>Sign in as a signer</h1>
        <p className="mt-1" style={{ color: "var(--tx-1)" }}>Approving payments and changing policy needs your personal signer token.</p>
        {SIGNERS.length === 0 ? (
          <p role="alert" className="mt-4 neg">No signers are configured. Set PROOFPAY_SIGNERS (name:token pairs, tokens of 16+ characters) and PROOFPAY_MASTER_KEY, then restart.</p>
        ) : (
          <LoginForm />
        )}
      </div>
    </div>
  );
}
