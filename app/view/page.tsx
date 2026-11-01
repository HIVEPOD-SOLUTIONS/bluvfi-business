import { PageHead } from "@/components/ui";
import { OpenWithKey } from "../auditor/Forms";

export const dynamic = "force-dynamic";

export default function View() {
  return (
    <div className="mx-auto max-w-2xl">
      <PageHead title="Open records" sub="Paste the view key you were given. You will see the records the treasury shared with you, until the key expires or is revoked." />
      <div className="card"><OpenWithKey /></div>
    </div>
  );
}
