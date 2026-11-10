import { createHash, randomBytes } from "node:crypto";
import { cfg } from "./business";
import { ASSET_ID, CHAIN_LABEL, NEAR_USDC_CONTRACT } from "./chains";
import { PUBLIC_BASE_URL, TREZU_APP_URL } from "./config";
import { addDaoProposal, checkCustody, payoutWindowMs, trezuDescription } from "./custody";
import { services } from "./services";
import { currentPolicy, state } from "./store";
import { signerNames } from "./team";
import type { CheckResult, CustodyRecord, Invoice, Quote, Verdict } from "./types";

/**
 * Payroll from a spreadsheet. Upload a CSV with one line per person (name, amount in USD, chain, stablecoin, address), and:
 *  1. every line is checked: a known chain and stablecoin the council allows, an address in the right format for that chain, the US OFAC
 *     sanctions list, the shared blocklist, and the same address twice;
 *  2. a signer sends it to the council: each person gets a NEAR Intents quote to their own chain and coin, and the agent files ONE DAO
 *     proposal (up to PER_PROPOSAL people; a larger team gets one per group) that pays every deposit address at once;
 *  3. the council approves it once in Trezu; NEAR Intents delivers each person's money on their chain; the app follows each payout.
 * The agent can still only propose: the council's vote is what pays. A line that fails a check blocks the run until it is fixed.
 */

export type PayrollRowStatus = "ready" | "blocked" | "proposed" | "sent" | "paid" | "refunded" | "failed" | "expired" | "rejected";
export interface PayrollRow {
  line: number;
  name: string;
  amountUsd: number;
  chain: string;
  asset: string;
  address: string;
  checks: CheckResult[];
  verdict: Verdict;
  status: PayrollRowStatus;
  quote?: Quote;
  proposal?: number;
  note?: string;
}
export interface PayrollProposal { id: number; url: string; rows: number[]; state: CustodyRecord["state"]; detail: string }
export interface PayrollRun {
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
  rows: PayrollRow[];
  totalUsd: number;
  status: "draft" | "proposed" | "done" | "cancelled";
  proposals: PayrollProposal[];
  sentBy?: string;
  sentAt?: string;
  /** SHA-256 of the people, amounts and addresses sent to the council: in every proposal's description. */
  evidenceHash?: string;
}

const requireSignerName = (who: string) => {
  if (!signerNames().includes(who)) throw new Error("Only a signer of this business can do that");
};

export const MAX_ROWS = 200;
/** People per DAO proposal: each pays two actions (register the deposit address, transfer), and a proposal must fit in one transaction's gas. */
export const PER_PROPOSAL = 8;
const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000";

const runs = (): PayrollRun[] => (state().payrollRuns ??= []);
export const payrollRuns = () => runs();
const find = (id: string) => {
  const r = runs().find((x) => x.id === id);
  if (!r) throw new Error("No such payroll run");
  return r;
};

// ---------- The spreadsheet ----------

const CHAIN_ALIASES: Record<string, string> = { near: "near", ethereum: "eth", eth: "eth", base: "base", arbitrum: "arb", arb: "arb", solana: "sol", sol: "sol" };
const ADDRESS: Record<string, RegExp> = {
  eth: /^0x[0-9a-fA-F]{40}$/, base: /^0x[0-9a-fA-F]{40}$/, arb: /^0x[0-9a-fA-F]{40}$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  near: /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/,
};
const COLUMNS: Record<string, keyof Pick<PayrollRow, "name" | "amountUsd" | "chain" | "asset" | "address">> = {
  name: "name", employee: "name", payee: "name",
  amount: "amountUsd", amount_usd: "amountUsd", "amount (usd)": "amountUsd", usd: "amountUsd",
  chain: "chain", network: "chain",
  asset: "asset", token: "asset", stablecoin: "asset", coin: "asset",
  address: "address", wallet: "address", payout_address: "address",
};

/** One CSV line into fields: commas, with "quoted, fields" and "" for a quote inside quotes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Read the CSV. Problems come back by line number, in plain words, so the person can fix the sheet. */
export function parsePayrollCsv(text: string): { rows: Omit<PayrollRow, "checks" | "verdict" | "status">[]; errors: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.trim());
  const errors: string[] = [];
  if (!lines.length) return { rows: [], errors: ["The file is empty"] };
  const head = splitLine(lines[0].l).map((h) => COLUMNS[h.toLowerCase()]);
  for (const need of ["name", "amountUsd", "chain", "address"] as const) if (!head.includes(need)) errors.push(`The first line must name the columns, including ${need === "amountUsd" ? "amount" : need}. For example: name,amount,chain,asset,address`);
  if (errors.length) return { rows: [], errors };
  if (lines.length - 1 > MAX_ROWS) return { rows: [], errors: [`At most ${MAX_ROWS} people per run`] };
  const rows: Omit<PayrollRow, "checks" | "verdict" | "status">[] = [];
  for (const { l, n } of lines.slice(1)) {
    const cells = splitLine(l);
    const get = (k: string) => cells[head.indexOf(k as never)] ?? "";
    const name = get("name").slice(0, 80);
    const chain = CHAIN_ALIASES[get("chain").toLowerCase()] ?? get("chain").toLowerCase();
    const asset = (get("asset") || "USDC").toUpperCase();
    const address = get("address");
    const amount = Number(get("amountUsd").replace(/[$,\s]/g, ""));
    const problems: string[] = [];
    if (!name) problems.push("no name");
    if (!(amount > 0) || amount > 1_000_000) problems.push(`"${get("amountUsd")}" is not an amount in USD`);
    if (!CHAIN_LABEL[chain]) problems.push(`"${get("chain")}" is not a chain we pay on (NEAR, Ethereum, Base, Arbitrum, Solana)`);
    else if (!ADDRESS[chain].test(address)) problems.push(`"${address}" is not a ${CHAIN_LABEL[chain]} address`);
    if (CHAIN_LABEL[chain] && !ASSET_ID[`${chain}:${asset}`]) problems.push(`${asset} on ${CHAIN_LABEL[chain]} is not a route NEAR Intents offers here`);
    if (problems.length) errors.push(`Line ${n}${name ? ` (${name})` : ""}: ${problems.join("; ")}`);
    else rows.push({ line: n, name, amountUsd: Math.round(amount * 100) / 100, chain, asset, address });
  }
  if (!rows.length && !errors.length) errors.push("There is nobody to pay in this file");
  return { rows, errors };
}

// ---------- Checking each person ----------

async function checkRow(r: Omit<PayrollRow, "checks" | "verdict" | "status">, seen: Map<string, string>): Promise<CheckResult[]> {
  const policy = currentPolicy();
  const out: CheckResult[] = [];
  out.push(policy.allowedChains.includes(r.chain)
    ? { id: "chain", label: "Allowed chain", verdict: "allow", reason: `${CHAIN_LABEL[r.chain]} is allowed.` }
    : { id: "chain", label: "Allowed chain", verdict: "block", reason: `The council's policy does not allow paying on ${CHAIN_LABEL[r.chain]}.` });
  out.push(policy.allowedAssets.includes(r.asset)
    ? { id: "asset", label: "Allowed asset", verdict: "allow", reason: `${r.asset} is allowed.` }
    : { id: "asset", label: "Allowed asset", verdict: "block", reason: `The council's policy does not allow paying in ${r.asset}.` });
  const listed = state().blocklist.find((b) => b.kind === "address" && b.value.toLowerCase() === r.address.toLowerCase());
  out.push(listed
    ? { id: "blocklist", label: "Shared blocklist", verdict: "block", reason: `This address is on the shared blocklist: ${listed.reason}` }
    : { id: "blocklist", label: "Shared blocklist", verdict: "allow", reason: "Not on the shared blocklist." });
  try {
    const s = await services.screenSanctions({ address: r.address, name: r.name });
    const exact = s.hits.find((h) => h.kind === "address" || h.exact);
    out.push(s.status === "unavailable"
      ? { id: "sanctions", label: "Sanctions (OFAC)", verdict: "warn", reason: `Not screened: ${s.note}` }
      : exact ? { id: "sanctions", label: "Sanctions (OFAC)", verdict: "block", reason: exact.detail }
      : s.hits.length ? { id: "sanctions", label: "Sanctions (OFAC)", verdict: "warn", reason: `Close to a listed name: ${s.hits[0].detail}. Check it is not the same person.` }
      : { id: "sanctions", label: "Sanctions (OFAC)", verdict: "allow", reason: s.note || "Not on the OFAC list." });
  } catch (e) {
    out.push({ id: "sanctions", label: "Sanctions (OFAC)", verdict: "warn", reason: `Not screened: ${(e as Error).message}` });
  }
  const key = `${r.chain}:${r.address.toLowerCase()}`;
  const twice = seen.get(key);
  out.push(twice
    ? { id: "duplicate", label: "Same address twice", verdict: "warn", reason: `${twice} is paid to the same address. Check this is meant.` }
    : { id: "duplicate", label: "Same address twice", verdict: "allow", reason: "One line for this address." });
  seen.set(key, r.name);
  return out;
}

const worstOf = (cs: CheckResult[]): Verdict => (cs.some((c) => c.verdict === "block") ? "block" : cs.some((c) => c.verdict === "warn") ? "warn" : "allow");

/** Read a CSV and check every person. Nothing is paid or proposed: that is a separate step a signer takes. */
export async function createPayrollRun(csv: string, title: string, by: string): Promise<PayrollRun> {
  requireSignerName(by);
  const { rows, errors } = parsePayrollCsv(csv);
  if (errors.length) throw new Error(errors.slice(0, 8).join(". ") + (errors.length > 8 ? `. And ${errors.length - 8} more.` : ""));
  const seen = new Map<string, string>();
  const checked: PayrollRow[] = [];
  for (const r of rows) {
    const checks = await checkRow(r, seen);
    const verdict = worstOf(checks);
    checked.push({ ...r, checks, verdict, status: verdict === "block" ? "blocked" : "ready" });
  }
  const run: PayrollRun = {
    id: `pr-${randomBytes(4).toString("hex")}`,
    title: title.trim().slice(0, 80) || `Payroll ${new Date().toISOString().slice(0, 7)}`,
    createdAt: new Date().toISOString(),
    createdBy: by,
    rows: checked,
    totalUsd: Math.round(checked.reduce((a, r) => a + r.amountUsd, 0) * 100) / 100,
    status: "draft",
    proposals: [],
  };
  runs().unshift(run);
  return run;
}

export function cancelPayrollRun(id: string, by: string): PayrollRun {
  requireSignerName(by);
  const run = find(id);
  if (run.status !== "draft") throw new Error("Only a run that has not been sent can be cancelled here. A sent one is rejected by the council in Trezu.");
  run.status = "cancelled";
  return run;
}

// ---------- One approval by the council ----------

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rawUsdc = (q: Quote, amountUsd: number) => q.amountInRaw ?? BigInt(Math.ceil(Number(q.amountIn || amountUsd) * 1e6)).toString();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function evidenceOf(run: PayrollRun): string {
  const lines = run.rows.map((r) => `${r.name}|${r.amountUsd}|${r.chain}:${r.asset}|${r.address}|${r.quote?.depositAddress ?? ""}`).join("\n");
  return createHash("sha256").update(`${run.id}\n${lines}`).digest("hex");
}

/**
 * Quote every person and file the proposal(s) for the council. The treasury must be a DAO (Sputnik / Trezu): the point is one vote by the
 * council, not the agent paying. Every person's line must have passed its checks.
 */
export async function sendPayrollRun(id: string, by: string): Promise<PayrollRun> {
  requireSignerName(by);
  const run = find(id);
  if (run.status !== "draft") throw new Error(`This run was already ${run.status}`);
  if (state().killSwitch) throw new Error("The kill switch is on: nothing can be sent");
  const blocked = run.rows.filter((r) => r.verdict === "block");
  if (blocked.length) throw new Error(`Fix or remove ${blocked.map((r) => r.name).join(", ")} first (line${blocked.length === 1 ? "" : "s"} ${blocked.map((r) => r.line).join(", ")}), then upload the file again.`);
  const custodyMode = cfg().CUSTODY;
  if (custodyMode !== "sputnik" && custodyMode !== "hybrid") throw new Error("Payroll is paid by one council vote, so the treasury must be a Sputnik DAO (Trezu). Set one up on the Overview.");
  if (cfg().CONFIDENTIAL) throw new Error("Payroll from a confidential treasury is not supported yet: send it from a public one");
  const check = await checkCustody();
  if (!check.ok) throw new Error(`Custody check failed: ${check.problems.join(" ")}`);

  // A quote per person, valid for the council's whole voting period plus a day: money sent to a dead deposit address can be lost.
  const window = await payoutWindowMs();
  for (const r of run.rows) {
    const inv: Invoice = {
      id: `${run.id}-${r.line}`, vendorName: r.name, vendorDomain: "", vendorContact: { channel: "email", handle: "" }, invoiceNumber: `${run.id}-${r.line}`,
      poNumber: "", amountUsd: r.amountUsd, asset: r.asset, chain: r.chain, payoutAddress: r.address, text: `Payroll ${run.title}`, receivedAt: run.createdAt,
    };
    r.quote = await services.quotePayout(inv, "basic", window);
    if (!r.quote.depositAddress) throw new Error(`NEAR Intents gave no deposit address for ${r.name}; nothing was sent`);
  }
  run.evidenceHash = evidenceOf(run);

  const groups: PayrollRow[][] = [];
  for (let i = 0; i < run.rows.length; i += PER_PROPOSAL) groups.push(run.rows.slice(i, i + PER_PROPOSAL));
  for (const [gi, group] of groups.entries()) {
    const actions = group.flatMap((r) => [
      { method_name: "storage_deposit", args: b64({ account_id: r.quote!.depositAddress, registration_only: true }), deposit: STORAGE_DEPOSIT_YOCTO, gas: "5000000000000" },
      { method_name: "ft_transfer", args: b64({ receiver_id: r.quote!.depositAddress, amount: rawUsdc(r.quote!, r.amountUsd), memo: `bluvfi-payroll:${run.id}:${r.line}` }), deposit: "1", gas: "10000000000000" },
    ]);
    const total = group.reduce((a, r) => a + r.amountUsd, 0);
    const validUntil = group.map((r) => r.quote!.timeWhenInactive ?? r.quote!.deadline ?? "").filter(Boolean).sort()[0] ?? "";
    const description = trezuDescription({
      proposal_action: "custom",
      title: `Payroll: ${run.title}${groups.length > 1 ? ` (part ${gi + 1} of ${groups.length})` : ""}, ${group.length} ${group.length === 1 ? "person" : "people"}, ${usd(total)}`,
      notes: `Proposed by the Bluvfi Business agent from a payroll sheet checked against the policy, the OFAC sanctions list and the shared blocklist. One approval pays everyone below; NEAR Intents delivers each person's money on their own chain. ${group.map((r) => `${r.name}: ${usd(r.amountUsd)} in ${r.asset} on ${CHAIN_LABEL[r.chain]} to ${r.address}`).join("; ")}.`,
      url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/payroll` : "",
      // Funds sent to a deposit address after it stops working can be lost: the council should not approve after this.
      depositValidUntil: validUntil,
      evidence: run.evidenceHash,
    });
    const pid = await addDaoProposal({ FunctionCall: { receiver_id: NEAR_USDC_CONTRACT, actions } }, description);
    run.proposals.push({ id: pid, url: `${TREZU_APP_URL}/${cfg().DAO_ACCOUNT}/requests/${pid}`, rows: group.map((r) => r.line), state: "pending", detail: `Proposal #${pid}, waiting for the council's votes.` });
    for (const r of group) Object.assign(r, { status: "proposed", proposal: pid });
  }
  Object.assign(run, { status: "proposed", sentBy: by, sentAt: new Date().toISOString() });
  return run;
}

// ---------- Following it ----------

const DONE: PayrollRowStatus[] = ["paid", "refunded", "failed", "expired", "rejected", "blocked"];

/** Ask the DAO about each proposal and NEAR Intents about each person's delivery. Safe to call any time. */
export async function refreshPayrollRun(id: string): Promise<PayrollRun> {
  const run = find(id);
  if (run.status !== "proposed") return run;
  for (const p of run.proposals) {
    if (p.state === "executed" || p.state === "rejected" || p.state === "failed") continue;
    const rec = await services.refreshPayout({ backend: "sputnik", ref: String(p.id), evidenceHash: run.evidenceHash ?? "", submittedAt: run.sentAt ?? "", state: "pending", detail: "" });
    Object.assign(p, { state: rec.state, detail: rec.detail });
    const rows = run.rows.filter((r) => p.rows.includes(r.line));
    if (rec.state === "rejected") for (const r of rows) Object.assign(r, { status: "rejected", note: "The council rejected this payroll. Nothing left the treasury." });
    else if (rec.state === "failed") for (const r of rows) Object.assign(r, { status: "failed", note: "Approved, but the transfer failed; the funds are still in the DAO." });
    else if (rec.state === "pending") {
      for (const r of rows) {
        const until = Date.parse(r.quote?.timeWhenInactive ?? r.quote?.deadline ?? "");
        if (until && Date.now() > until) Object.assign(r, { status: "expired", note: "The deposit address stopped working before the council approved. Reject this proposal in Trezu and send the payroll again." });
      }
    } else if (rec.state === "executed") for (const r of rows) if (r.status === "proposed") r.status = "sent";
  }
  for (const r of run.rows.filter((x) => x.status === "sent")) {
    const s = await services.swapStatus(r.quote!.depositAddress, r.quote!.depositMemo);
    if (s === "SUCCESS") Object.assign(r, { status: "paid", note: `Delivered in ${r.asset} on ${CHAIN_LABEL[r.chain]}.` });
    else if (s === "REFUNDED") Object.assign(r, { status: "refunded", note: "NEAR Intents could not deliver and refunded the treasury." });
    else if (s === "FAILED") Object.assign(r, { status: "failed", note: "NEAR Intents could not deliver this payout." });
    else r.note = `On its way (${s.toLowerCase().replace(/_/g, " ")}).`;
  }
  if (run.rows.every((r) => DONE.includes(r.status))) run.status = "done";
  return run;
}

/** Every payroll run waiting on the council or on delivery (the scheduled settlement poll). */
export async function refreshOpenPayroll(): Promise<{ id: string; status: string }[]> {
  const out: { id: string; status: string }[] = [];
  for (const r of runs().filter((x) => x.status === "proposed")) out.push({ id: r.id, status: (await refreshPayrollRun(r.id)).status });
  return out;
}

/** Demo mode: a council member votes on the run's proposals in the simulated DAO. On mainnet the council votes in Trezu. */
export async function demoPayrollVote(id: string, member: string, approve: boolean): Promise<PayrollRun> {
  const { isDemo } = await import("./tenant");
  if (!isDemo()) throw new Error("On mainnet the council votes in Trezu");
  requireSignerName(member);
  const { demoDao } = await import("./custody");
  const run = find(id);
  for (const p of run.proposals) {
    if (demoDao().get(p.id).status === "InProgress") demoDao().vote(p.id, member, approve ? "VoteApprove" : "VoteReject");
  }
  return refreshPayrollRun(id);
}

export const SAMPLE_CSV = `name,amount,chain,asset,address
Ada Okafor,4200,base,USDC,0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed
Bruno Silva,3800,solana,USDC,7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV
Chen Wei,5100,near,USDC,chen-wei.near
Dana Levi,2950,arbitrum,USDT,0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359`;
