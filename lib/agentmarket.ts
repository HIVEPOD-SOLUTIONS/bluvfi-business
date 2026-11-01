import { publicCheck } from "./agent";
import { AGENT_MARKET_BASE, AGENT_MARKET_TOKEN } from "./config";
import type { CheckResponse } from "./types";

/**
 * Agent Market worker (docs.market.near.ai/list-your-agent): a self-hosted agent polls its assignments with an
 * `aat_` token, declares work started, and submits a Markdown deliverable. Here the work is one Bluvfi Business Check:
 * the payee comes from a JSON object, or an address/domain, found in the job description or latest buyer message.
 * If no payee can be found, a message asks for one and nothing is submitted.
 */
interface Item {
  assignment: { assignmentId: string; startedAt?: string | null };
  job: { title: string; description: string };
  latestMessage?: { body: string; senderSide: string } | null;
}

const headers = () => ({ authorization: `Bearer ${AGENT_MARKET_TOKEN}`, "content-type": "application/json" });
const api = (path: string, init?: RequestInit) => fetch(`${AGENT_MARKET_BASE}${path}`, { ...init, headers: headers(), signal: AbortSignal.timeout(30_000) });

export function parsePayee(text: string): { payoutAddress: string; vendorName?: string; vendorDomain?: string; chain?: string; invoiceText: string } | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      if (typeof o.payoutAddress === "string")
        return { payoutAddress: o.payoutAddress, vendorName: o.vendorName as string | undefined, vendorDomain: o.vendorDomain as string | undefined, chain: o.chain as string | undefined, invoiceText: text };
    } catch {
      /* fall through to pattern matching */
    }
  }
  const evm = /\b0x[a-fA-F0-9]{40}\b/.exec(text)?.[0];
  const near = /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.near\b/.exec(text)?.[0];
  const address = evm ?? near;
  if (!address) return null;
  return { payoutAddress: address, chain: evm ? "eth" : "near", invoiceText: text };
}

export const verdictMarkdown = (r: CheckResponse, address: string) =>
  `# Bluvfi Business Check: ${r.verdict.toUpperCase()}\n\nPayee: \`${address}\`\n\n| Check | Result | Detail |\n|---|---|---|\n` +
  r.checks.map((c) => `| ${c.label} | ${c.verdict} | ${c.reason.replace(/\|/g, "\\|")} |`).join("\n") +
  `\n\nChecked ${r.checkedAt}. This is a risk signal, not a guarantee: settled funds cannot be recalled.`;

/** One polling pass. Returns what it did per assignment. */
export async function pollAgentMarket(): Promise<{ assignmentId: string; action: "submitted" | "asked" | "failed"; detail?: string }[]> {
  if (!AGENT_MARKET_TOKEN) throw new Error("AGENT_MARKET_TOKEN is not set");
  const res = await api("/v1/agents/me/assignments?status=in_progress");
  if (!res.ok) throw new Error(`Agent Market assignments failed: ${res.status}`);
  const { assignments } = (await res.json()) as { assignments: Item[] };
  const out: { assignmentId: string; action: "submitted" | "asked" | "failed"; detail?: string }[] = [];
  for (const it of assignments) {
    const id = it.assignment.assignmentId;
    try {
      await api(`/v1/assignments/${id}/start`, { method: "POST" }); // idempotent
      const buyer = it.latestMessage?.senderSide && it.latestMessage.senderSide !== "worker" ? it.latestMessage.body : "";
      const payee = parsePayee(`${it.job.description}\n${buyer}`);
      if (!payee) {
        await api(`/v1/assignments/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ body: "Which payee should I check? Send a JSON object like {\"payoutAddress\":\"…\",\"vendorName\":\"…\",\"vendorDomain\":\"…\",\"chain\":\"near\"} or just the address.", clientRequestId: `ask-${id}` }),
        });
        out.push({ assignmentId: id, action: "asked" });
        continue;
      }
      const result = await publicCheck(payee);
      const sub = await api(`/v1/assignments/${id}/submit`, { method: "POST", body: JSON.stringify({ deliverableMarkdown: verdictMarkdown(result, payee.payoutAddress) }) });
      out.push(sub.ok ? { assignmentId: id, action: "submitted" } : { assignmentId: id, action: "failed", detail: `submit ${sub.status}` });
    } catch (e) {
      out.push({ assignmentId: id, action: "failed", detail: (e as Error).message });
    }
  }
  return out;
}
