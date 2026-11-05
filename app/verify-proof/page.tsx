import { PageHead } from "@/components/ui";
import { ProofChecker } from "@/components/ProofChecker";

export const dynamic = "force-dynamic";

/** Public: anyone who was handed a proof file can check it here, with no account. */
export default function VerifyProof() {
  return (
    <div className="mx-auto max-w-2xl">
      <PageHead
        title="Check a proof"
        sub="Were you given a zero-knowledge proof file from a Bluvfi Business treasury? Paste it or choose it here. The check runs the proof system itself and tells you, in plain words, what is proved and what it rests on."
      />
      <ProofChecker />
    </div>
  );
}
