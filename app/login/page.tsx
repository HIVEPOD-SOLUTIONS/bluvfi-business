import Link from "next/link";
import { DEMO, PRIVY_APP_ID, PRIVY_LOGIN, SIGNERS, SIGNUP_OPEN } from "@/lib/config";
import { LoginForm } from "./LoginForm";
import { PrivyLogin } from "./PrivyLogin";

export const dynamic = "force-dynamic";

export default function Login() {
  const configured = SIGNERS.length > 0 || PRIVY_LOGIN;
  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="card">
        <h1>Sign in</h1>
        <p className="mt-1" style={{ color: "var(--tx-1)" }}>Approving payments and changing policy needs a signer: sign in with your email, or with your personal signer token.</p>
        {!configured ? (
          <>
            <p role="alert" className="mt-4 neg">No signers are configured. Set BLUVFI_SIGNERS (name:token pairs, tokens of 16+ characters) and BLUVFI_MASTER_KEY, or PRIVY_APP_ID and PRIVY_APP_SECRET (so businesses can sign up), then restart.</p>
            <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Or <Link href="/setup" style={{ color: "#8c8cff" }}>set up a treasury from the browser</Link>: it creates the DAO and the agent with your wallet, and makes signer tokens for you.</p>
          </>
        ) : (
          <>
            {DEMO && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Demo mode: sign in as Maya with <span className="mono">demo-signer-maya-token</span> (or Devon with <span className="mono">demo-signer-devon-token</span>).</p>}
            {PRIVY_LOGIN && <div className="mt-4"><PrivyLogin appId={PRIVY_APP_ID} signupOpen={SIGNUP_OPEN} /></div>}
            {PRIVY_LOGIN && SIGNERS.length > 0 && <p className="mt-4 text-sm" style={{ color: "var(--tx-2)" }}>Or with a signer token:</p>}
            {SIGNERS.length > 0 && <LoginForm />}
          </>
        )}
      </div>
    </div>
  );
}
