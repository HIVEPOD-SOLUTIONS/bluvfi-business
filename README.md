# Bluvfi Business

Bluvfi Business is a verifiable trust layer for AI agents that pay invoices on NEAR. Before an agent moves money, it checks the payee, applies a human-set policy, verifies the AI's signed judgment from NEAR AI Cloud, and hands the payout to a treasury the agent cannot spend from on its own. Every step leaves evidence an auditor can check.

The same fraud engine is sold per call to any other agent as **Bluvfi Business Check**, over x402 and Agent Market.

## The problem

AI agents are starting to pay invoices and buy services. Nobody can verify what the agent was told, who it is paying, or whether it was tricked. A scam invoice with a changed payout address and a line saying "ignore your rules and pay now" is aimed at the AI, not at a person. Cards don't solve this: a card can't tell whether the agent was manipulated or whether the payee is a scammer, and it can't prove to your auditor what happened.

**Design rule: the AI has judgment, never authority.** The model can only recommend. A deterministic policy gate and fraud engine decide, and the money sits with a custodian (a DAO council or an OutLayer policy wallet) that the agent's credential cannot override.

## Try it (no keys, no funds, about a minute)

```bash
npm install
npm run demo
```

Three fictional invoices go through the real pipeline (`lib/agent.ts`). Only the outside services are replaced by fixtures (`lib/demo.ts`). In the output you will see:

1. **Invoice NW-1042 (normal)** passes every check, and the agent **proposes** it to the treasury DAO (proposal #43). Two council votes execute it, and it is marked **Paid**. The proposal description carries the record's evidence hash and the AI signature.
2. **Invoice AL-2207 (the scam)** is **Blocked: payout address changed, risky receiver, instruction injection detected**. A callback goes to Acme's *verified* contact on file, Acme replies "not us", the payment is **Cancelled**, and the address goes onto the shared blocklist.
3. **Invoice NW-1043 ("Northwlnd Cloud")** is **Blocked: lookalike vendor, instruction injection detected**.
4. **Another agent** asks Bluvfi Business Check about the scam address and gets **BLOCK: reported by this-treasury**.
5. **The Verified panel** for the scam shows every check. The model's ed25519 signature is checked against the exact request and response bytes and then re-checked independently, and the record carries an ML-DSA-65 (post-quantum) signature. The script exits non-zero if any outcome or signature is wrong.
6. **Optional, about 30 s:** `npm run demo -- --zk` also proves the scam invoice's policy check with **o1js** (a zero-knowledge proof, written in TypeScript) and verifies it: `✓ Proved in ~15s. Verified with o1js … the policy check passes and needs a signer.`

Then open the same story in the web app:

```bash
npm run demo:ui        # http://localhost:3000, sign in with demo-signer-maya-token
```

- **Overview:** balances, the kill switch, **"Who can move the money"** (custody facts), and holds needing attention.
- **Payments → NW-1042:** the **Treasury** card shows DAO proposal #43 with Devon's vote. Click **Vote approve as maya** and it executes and settles.
- **Payments → AL-2207:** the scam. Click **Vendor said "not us"** and watch it cancel and blocklist.
- **Check:** the public network page, plus a playground for the free tier.

### What demo mode does and does not prove

The demo's NEAR AI reviews in `fixtures/nearai/` are signed with a **public demo key** in exactly NEAR AI's `provider_tee` format. They are labelled `demo-fixture` everywhere, and **hardware attestation is never claimed for them** (the Verified panel shows TDX/GPU as not verified). With a NEAR AI key, `npm run fixtures:record` replaces them with real recorded responses (`recorded`). Replaying those re-runs every check, including Intel TDX (dcap-qvl) and NVIDIA NRAS. The DAO in demo mode is simulated in app state with the same rules: propose, vote, execute at the threshold.

## Live mode

```bash
cp .env.example .env.local   # fill in the required block and one custody option
npm run dev
```

- **Required:** `BLUVFI_MASTER_KEY`, `BLUVFI_SIGNERS`, `NEAR_AI_API_KEY` ($10 of free credits via NEAR Builders).
- **What's missing:** the Overview lists any unset variables, and the custody card says whether the agent's credential is really scoped.
- **Safe for judging:** set `ONECLICK_DRY=1` to get real 1Click prices with **no deposit address**, so nothing can be paid.

## How a payment moves

`lib/agent.ts` holds the whole pipeline.

1. **Redact before reasoning.** NEAR AI Cloud's `POST /v1/privacy/redact` (`openai/privacy-filter`, inside its TEE gateway) strips names and bank details, then local patterns strip wallets and handles. If the filter is down, only the patterns run and the record says so. This is Electric Capital's Quest principle.
2. **Signed judgment.** A private model on NEAR AI Cloud reviews the redacted invoice. The attestation is fetched with our own nonce, then the completion, then the response signature (`lib/nearai.ts`). We verify:
   - the signed text matches the exact request and response bytes for the `signature_kind`;
   - the ed25519 signature;
   - exactly one attestation report vouches for the signer;
   - the Intel TDX quote, with dcap-qvl (TCB UpToDate), its report_data binding, RTMR3 replay and MRCONFIGID;
   - the NVIDIA evidence, via NRAS.

   If anything fails, the payment is **held for a human**, never paid.
3. **Deterministic checks.** The policy gate (`lib/policy.ts`) covers the kill switch, limits, chains, assets and allowlist. The fraud engine (`lib/fraud.ts`) covers:
   - changed payout details
   - duplicate invoice
   - PO mismatch
   - lookalike vendor
   - counterparty signals (NEAR and EVM RPC, NearBlocks account age)
   - the shared blocklist
   - prompt injection
4. **Strictest result wins.** The AI can tighten a result but never loosen it.
5. **Callback on any payout change.** The vendor is contacted on their **verified channel on file** (never the invoice's): Telegram, or a Twilio voice call. The vendor presses 1/2 or answers by voice, and the voice answer is transcribed by **Whisper on NEAR AI**. "Not us" cancels the payment and blocklists the address.
6. **Hold window.** Suspicious payments wait, cancellable. Settled funds on other chains cannot be frozen, so Bluvfi Business stops money *before* it leaves.
7. **Payout.** A real NEAR Intents 1Click quote (with `confidentiality: public | basic | advanced` per payment) gives a deposit address. The payout then goes to the **custodian**:
   - **Sputnik DAO / Trezu:** the agent calls `add_proposal` with `storage_deposit` + `ft_transfer` of USDC to the deposit address. The council's approving vote executes it.
   - **OutLayer:** `POST /wallet/v1/call ft_transfer`. OutLayer's policy enforces limits and allowlists inside Intel TDX, and above its threshold the request waits for approvers.
   - **Hybrid (`CUSTODY=hybrid`):** the DAO is the vault and an OutLayer wallet is a small spending wallet. Payments under the approval threshold are paid from the wallet; payments at or over it, or larger than the wallet holds, become DAO proposals. When the wallet falls below its low mark (default: the daily limit) the agent files one DAO proposal to refill it to its target (default: twice the daily limit), and the council votes on it.
   - **Manual:** a signer sends from their own wallet and records the transaction.
8. **Evidence.** A hash of the record is written onchain with the payout: in the DAO proposal description, or in the `ft_transfer` memo. The policy check is also proved in zero knowledge with o1js (`lib/zk-program.ts`), in the background, and the proof is verified on the payment page. The record is hash-chained, signed with ML-DSA-65, and kept encrypted (AES-256-GCM). Auditors get time-limited view keys (`/view`), a CSV and a PDF.

## Security model

- **The agent cannot move funds.**
  - **Sputnik:** the agent key is a NEAR **function-call access key** limited to `add_proposal` on the DAO. Such a key can attach no deposit, so the DAO's bond must be 0.
  - **The agent holds only that key.** Every key on the agent account must be one that can call `add_proposal` on the DAO and nothing else. A full-access key, or a key for any other contract or method, fails the check, and the Overview shows the `near account delete-keys` command to remove it. So no one, the agent included, can transfer from the agent account, add keys, deploy code or vote with it.
  - **The app verifies this from the chain** (`view_access_key`, `view_access_key_list` and the DAO's `get_policy`) and refuses to submit payouts if any key is full-access or scoped to anything else, if the agent's DAO role can vote, if the relayer account can vote, or if the bond is not 0 (`lib/custody.ts checkCustody`). The DAO roles mean the agent can propose but never approve a payout or change the DAO's policy.
  - **`add_proposal` is our `request_payment`.** The spec names a contract method `request_payment`; with an existing DAO, filing a proposal is that request, and the council's vote is the approval.
  - **OutLayer:** the agent holds only an API key, and the app refuses a wallet with no stored policy.
  - **Hybrid:** both checks must pass, **and** OutLayer must cap each payment at the approval threshold or less. Otherwise the app refuses to pay. So a large payment routed to the wallet, by a bug or a compromised server, is refused by OutLayer, and can only leave through a council vote. The spending wallet's balance, read from the chain, is the most that can ever leave without one.
  - **Post-quantum option:** the agent key may also be ML-DSA (`mldsa65:`), which NEAR and near-api-js support.
- **Gas allowance lock-out.** A function-call key whose gas allowance runs out stops working. Because the agent account has no full-access key, it cannot add a new key itself: the account is locked. Nothing is lost, since the agent account holds no treasury funds. The fix is a new agent account with a fresh scoped key, which the council swaps into the agent's DAO role. The custody check warns when the allowance is nearly used. A key added with no allowance limit draws gas from the account's own NEAR balance instead, so keep a little NEAR there.
- **Kill switch.** It stops this app immediately. For a hard stop onchain, the Overview shows the `near account delete-keys` command that revokes the agent's key. The council can also reject or remove open proposals.
- **Gasless votes.** A council member's browser holds a key that may only call `act_proposal` on the DAO, and signs a NEP-366 delegate action. Before anything is relayed (`relayVote`), the relayer checks that it is:
  - one `act_proposal` on our DAO;
  - a vote action;
  - zero deposit;
  - sent by a council member listed in the DAO policy.
- **Signer sessions** are HMAC-signed cookies. Approvals use the signed-in signer, never a name from the browser. Policy changes need `APPROVAL_THRESHOLD_SIGNERS` distinct signers.
- **Public routes:** sign-in, pay links, Check, the public ledger, `/view`, `/api/openapi`, the app icon and manifest, and webhooks. Each webhook verifies its own secret or signature (`proxy.ts`).
- **What is attested, and what isn't:**
  - **Attested:** the model, the hardware it runs on, and its signed output.
  - **Not attested:** this app's own server; we do not run it in a TEE.
  - **Not checked:** NEAR AI's gateway attestation and TLS binding, which its docs mark optional.
  - **Not checked locally:** the NRAS JWT signature.

### Layer 1 (policy set by humans) without our own contract

Each requirement is met by something that already exists, or by this app's gate. Nothing here is a contract we wrote.

| Requirement | What enforces it | Where it is enforced |
|---|---|---|
| The agent cannot spend | Sputnik: a function-call key limited to `add_proposal`, checked from the chain before every payout, and the **only** kind of key on the agent account (`view_access_key_list`: no full-access key, no key for anything else), **and** the agent holds only a Requestor-style role: the check fails if any DAO role gives it voting rights, so it can propose but never approve. OutLayer: an API key, with keys held in a TEE | **Onchain / TEE** |
| Council approval and the approval threshold | Sputnik's vote threshold (or OutLayer's approvers) executes the payout. The app reads the threshold the DAO actually applies to payouts (from `get_policy`, the role's own vote policy first) and shows it on the Overview, warning if one council member can approve alone | **Onchain / TEE** |
| Per-payment and daily limits, permitted chains and assets | OutLayer's stored policy where used; always the app's policy gate, re-checked at the moment of release (`lib/policy.ts`, `release()`) | OutLayer: TEE, and the custody check compares OutLayer's per-payment limit with the app's and says whether it backs it. Sputnik: **this app only**, because a DAO has no spending limits; the council still sees every proposal |
| Most that can leave without a council vote | Hybrid: the spending wallet's balance, refilled only by DAO proposals the council approves, and each payment from it capped by OutLayer at the approval threshold. Sputnik: nothing leaves without a vote | **Onchain balance + TEE** with hybrid |
| Vendor allowlist | The app's policy gate (a non-listed vendor is held for a human); OutLayer address rules where used | App, plus OutLayer where used |
| Hold window | Held payments cannot be approved until `holdUntil`; cancelling is always possible. Because the agent can only act by submitting a payout to the custodian, and that happens after the window and a signer's approval, the hold sits in front of the only onchain action. Neither a DAO nor OutLayer offers a timelock of its own | App, in front of the onchain step |
| Kill switch any signer can flip | App flag (who and when is recorded) stops all payments and API spend at once. **Onchain hard stops, both generated for you on the Overview:** (1) the council removes the agent from its DAO role (a `ChangePolicyRemoveRole` / `ChangePolicyAddOrUpdateRole` proposal built from the live policy, the same as Members in Trezu), which needs no key held by the agent's owner, and the app then stops submitting on its own at its next custody check (checks are cached for up to five minutes); (2) the agent key's owner deletes the key (`near account delete-keys …`) | App flag, plus council or key-owner action onchain |
| Policy changes only through a multisig, every version hashed | **Sputnik custody: the DAO council approves each change onchain.** A signer drafts it; the agent files, with its scoped key, a proposal that does nothing but carry the change's tag (version plus a hash of the exact rules) as a `FunctionCall` to the DAO's own view method `get_last_proposal_id` (Trezu-style roles have no `Vote` kind; a plain `Vote` proposal is accepted too); the council votes; the app applies the change only once it reads that proposal as `Approved` from the chain (`lib/governance.ts`). Other custody: `APPROVAL_THRESHOLD_SIGNERS` distinct named signers. Always: proposals are validated, each version's hash is re-verified on the Policy page, a Sputnik payout proposal states the policy version and hash it was approved under, and an OutLayer memo carries the record's evidence hash, which covers it | **Onchain (DAO) with Sputnik**, app-level otherwise |
| Function-call key lock-out | A function-call key whose gas allowance runs out stops working until the owner adds a new one. The custody check warns when the allowance is nearly used | Checked from the chain |

**Trezu note:** a Trezu treasury has the roles Requestor (creates payment requests, cannot vote), Finance (votes on payments) and Governance (members, voting rules, policy). Put the agent in **Requestor only**. Trezu creates DAOs with a 0.1 NEAR proposal bond, which a function-call key cannot attach, so a Governance proposal must set the bond to 0 first; the custody check says so until it is done.

**Hybrid custody closes most of that gap without a contract:** routine payments come from a wallet whose limits OutLayer enforces in a TEE, and whose balance is a hard ceiling; everything larger goes to the council. What stays app-only is the hold window and the vendor allowlist for DAO payouts.

What this does **not** give you, and cannot without writing a contract: with Sputnik custody, a compromised app server could ignore its own limits, allowlist and hold window, because a DAO enforces votes, not amounts or delays. The council reviewing each proposal is the backstop, and revoking the agent key is the hard stop. OutLayer's policy is the option that enforces limits outside this app. While the kill switch is on, the Overview lists payouts still waiting onchain, with links to reject them; the agent cannot withdraw them itself.

### No contract, so no contract audit

This build deploys **no smart contract**, so there are no contract audit findings to report. Custody uses audited, widely deployed code instead: Sputnik DAO v2 (what Trezu runs) or OutLayer. What we check about that setup at runtime is listed under *Security model*.

## What is and is not done

| Piece | Status |
|---|---|
| Fraud checks, policy gate, kill switch, hold window, callbacks, blocklist | Done, unit-tested |
| NEAR AI signature + TDX + NVIDIA verification | Written to NEAR AI's verification docs and unit-tested against an independent implementation. **Not yet run end to end with a real key.** Record fixtures with one to confirm |
| NEAR AI privacy filter (`/v1/privacy/redact`) | Done to the API reference, tested with a mock; not run against the live endpoint |
| Sputnik DAO custody (scoped key, proposals, status) | Done, tested against a mocked NEAR RPC. **Not yet run on mainnet** |
| Gasless council votes (NEP-366 relayer) | Done. Relay guards are tested; browser signing has not been run against mainnet |
| OutLayer custody | Done to OutLayer's OpenAPI document, tested with mocks. **Not yet run against OutLayer** |
| Hybrid custody (DAO vault + OutLayer spending wallet) | Done: routing by size and balance, the combined custody check, top-up proposals, both balances on the Overview (`tests/hybrid.test.ts`). Tested against a mocked NEAR RPC and OutLayer API. **Not yet run on mainnet or against OutLayer** |
| 1Click quotes, confidentiality, status, dry-run | Field names match the 1Click OpenAPI document. Never executed with funds |
| Whisper voice answers | Done to NEAR AI's API reference; not run against Twilio or NEAR AI |
| Check over x402 | **PingPay Agent Pay** (x402 v2: buyers pay USDC on Base, we receive USDC on NEAR through NEAR Intents), or any x402 v1 facilitator that supports `near`. PingPay routes and shapes were checked against its docs and live endpoints on 2026-11-01: `https://staging.pingpay.io/agentpay/x402/supported` answers as documented and `prepare` requires a key; the documented `https://pay.pingpay.io` did not yet serve these routes. The app checks `/supported` before taking payments. **Not yet run with a funded payment** |
| Agent Market worker | Done (`lib/agentmarket.ts`). You still create the listing and token in their UI |
| Agent buys APIs over x402 | Policy-gated; the signing is delegated to `X402_PAYER_URL` (not bundled) |
| Receivable pay links | With `AURORA_API_KEY`, **Aurora's Intents swap widget**: the client connects any wallet (EVM, Solana, NEAR, Stellar) and pays with the token they hold. Every quote comes from our server (`fetchQuote`), which forces the invoice amount (EXACT_OUTPUT), USDC on NEAR and our treasury, so the widget sends exactly that quote to a 1Click deposit address we then track. Renders and quotes in the browser; **not yet paid from a real wallet**. Without a key, a deposit address to send to by hand |
| NEAR Business / Trezu | Agent proposals use Trezu's own description format (`* Proposal Action: payment-transfer <br>* Title: … <br>* Recipient: … <br>* Destination Network: …`), so they appear in Trezu as **Payment Requests** to the vendor, with the deposit address and quote signature, deep-linked at `https://trezu.app/<dao>/requests/<id>`. NEAR Business has no public API and its treasuries are confidential (private shard), so the agent cannot propose into one; a public Sputnik DAO opened in Trezu is the supported target |
| ML-DSA-65 records, encrypted records, view keys | Done |
| Demo mode, fixtures, hosted demo | `npm run demo`, `npm run demo:ui`, Docker with `BLUVFI_DEMO=1` (`npm run demo:serve`) |
| Zero-knowledge proof of the policy check | Written in TypeScript with **o1js** (`lib/zk-program.ts`): the policy gate as a ZK circuit. Every payment's statement (amounts, limits, chain, asset, allowlist, policy hash, payment) is proved in a background process (~15 s) and verified on the payment page against the committed verification key (`zk/verification-key.json`), plus a check that the proof's statement is this payment's and its output equals the policy result. Runs on Windows, macOS and Linux; tested with real proofs. `npm run demo -- --zk` shows it. See `zk/README.md` |
| Persistence | JSON snapshot (`.data/`), single process, no database |

**Not built, and why:**
- **Our own smart contract:** out of scope by choice; custody is Sputnik or OutLayer instead.
- **Proposing into a NEAR Business confidential treasury:** no public API, and those treasuries live on a private shard. Public Sputnik DAOs in Trezu are supported instead (see above).

## NEAR tech used, and why

| Tool | How Bluvfi Business uses it |
|---|---|
| **NEAR AI Cloud** (private models in TEEs) | The invoice reviewer, with attestation and signature checks. It also runs the privacy filter before reasoning and Whisper for voice callbacks |
| **Function-call access keys** | The agent's only credential: `add_proposal` on the DAO and nothing else. Council browsers hold `act_proposal`-only keys |
| **Sputnik DAO / Trezu** | Treasury custody and multisig. We don't rebuild the multisig; the agent proposes Payment Requests in Trezu's format and humans vote |
| **Aurora Intents swap widget** | Clients pay invoices from any wallet and token; amount, asset and recipient are fixed by our server |
| **Meta transactions (NEP-366)** | Gasless council votes through a relayer that only relays votes |
| **NEAR Intents / 1Click** | Cross-chain payouts in USDC to vendors on Base, Arbitrum, Ethereum, Solana and NEAR, with per-payment confidentiality. The same flow powers client pay links |
| **OutLayer** | Alternative custody, or the spending wallet in hybrid custody: a policy wallet whose limits and approvals are enforced in Intel TDX |
| **x402 (PingPay Agent Pay)** | Check sold per call; the agent's own API spending is gated by the same policy |
| **Agent Market** | A worker that answers hired jobs with Bluvfi Business Check |
| **NEAR RPC / NearBlocks** | Treasury balances, counterparty signals, and onchain custody checks |
| **ML-DSA** | Post-quantum record signatures. Agent keys may be `mldsa65:` |

## Libraries and AI-generated code

- **Libraries:** Next.js 16, React 19, Tailwind 4, `near-api-js` 7, `borsh`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum`, `@phala/dcap-qvl`, `@aurora-is-near/intents-swap-widget-standalone`, `o1js`, `pdf-lib`, `tsx`.
- **AI assistance:** much of this code was written with AI assistance (Claude).
- **Credit:** Quest (Electric Capital) inspired the redact-before-reasoning step.
- **Hackathon baseline:** commit `dc95082` (2026-11-01) is the first commit. All work is within the NEAR HACKATHON window.

## Business model and roadmap

- **Treasury:** a per-seat or per-payment fee for companies, DAOs and NEAR Business / Trezu treasuries.
- **Check:** sold per call to any agent over x402 and Agent Market.
- **The network effect:** every treasury that uses Bluvfi Business adds evidence-backed reports to the shared blocklist, which makes Check better for every other agent. This works like a card network's fraud network, but for agent payments.

**Roadmap:**
- ZK KYB ("verified business, not sanctioned", without sharing documents)
- Agent credit lines against treasury assets on Rhea
- Virtual cards
- Cross-chain sharing of fraud intelligence
- Post-quantum agent keys by default

## Tests

```bash
npm test         # 70 tests; outside services are mocked inside tests/ only
npm run demo     # the end-to-end story; exits non-zero if an outcome or a signature is wrong
```

License: MIT (see `LICENSE`).
