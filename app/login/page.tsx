import { Logo } from "@/components/Nav";
import { DEMO, SIGNERS } from "@/lib/config";
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
          <p role="alert" className="mt-4 neg">No signers are configured. Set BLUVFI_SIGNERS (name:token pairs, tokens of 16+ characters) and BLUVFI_MASTER_KEY, then restart.</p>
        ) : (
          <>
            {DEMO && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Demo mode: sign in as Maya with <span className="mono">demo-signer-maya-token</span> (or Devon with <span className="mono">demo-signer-devon-token</span>).</p>}
            <LoginForm />
          </>
        )}
      </div>
    </div>
  );
}
