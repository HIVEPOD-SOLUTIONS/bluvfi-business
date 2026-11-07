"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";

/** With `remove`, a button that removes that person; without, a form that adds a person by email. */
export function TeamEditor({ remove }: { remove?: string }) {
  const { run, error, loading } = useAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("approver");
  if (remove) {
    return (
      <span className="inline-flex flex-col">
        <button className="btn btn-ghost btn-sm" disabled={loading} aria-busy={loading} onClick={() => window.confirm(`Remove ${remove}? Their session ends immediately.`) && run("/api/team", { email: remove }, "DELETE")}>Remove</button>
        <ErrorLine msg={error} />
      </span>
    );
  }
  return (
    <form
      className="grid gap-2 sm:max-w-md"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run("/api/team", { email, role })) setEmail("");
      }}
    >
      <label className="block"><span className="label">Email they will sign in with</span>
        <input className="input mt-1" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block"><span className="label">Role</span>
        <select className="input mt-1" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="approver">Approver: approves payments and policy changes</option>
          <option value="owner">Owner: also manages the team and the treasury setup</option>
        </select></label>
      <button className="btn btn-primary" disabled={loading || !email}>{loading ? "Adding…" : "Add to the team"}</button>
      <ErrorLine msg={error} />
    </form>
  );
}
