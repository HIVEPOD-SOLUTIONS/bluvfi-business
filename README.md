# Proofpay

Proofpay sits between an AI agent and a treasury on **NEAR mainnet**. It checks the payee, enforces human-set policy, verifies the AI's signed judgment, and leaves evidence an auditor can check. The same fraud engine is offered to any agent per call as **Proofpay Check** (x402).

There is no smart contract, and there is **no demo mode**: every service is the real one, and anything not configured makes the affected feature refuse to run.

## Run it

```bash
npm install
cp .env.example .env.local    # fill in the required block
npm run dev                   # http://localhost:3000
npm test                      # 23 tests; outside services are replaced by fakes that live only in tests/
```

Required: `PROOFPAY_MASTER_KEY`, `PROOFPAY_SIGNERS`, `TREASURY_ACCOUNT`, `NEAR_AI_API_KEY`. The Overview page lists whatever is missing. Sign in at `/login` with a signer token.

Then: **Vendors** (add a vendor with a verified contact channel and payout address, add POs) → **Payments** (submit an invoice) → read the **Verified** panel.

## How a payment moves

`lib/agent.ts` is the whole pipeline. **The AI has judgment, never authority.**

1. Redact emails, phones, IBANs, wallets and handles with local patterns (`lib/redact.ts`). Patterns are not a guarantee; free-text names can survive.
2. Ask a private model on NEAR AI Cloud for a recommendation, following its verification docs (`lib/nearai.ts`): attestation report with our own nonce, then the completion, then the response signature. If any step fails the payment is **held for a human**, never paid.
3. Verify here (`lib/nearai-core.ts`): the signed text must match the `signature_kind` (`model:reqHash:respHash` for `provider_tee`, `reqHash:respHash` for `gateway`) with hashes over the exact request and response bytes; ed25519 signature; exactly one attestation report matching the signer; the Intel TDX quote verified with `@phala/dcap-qvl` (TCB must be UpToDate) and its `report_data` read **from the quote** and required to equal the signer identity plus our nonce; GPU evidence checked against NVIDIA NRAS.
4. Deterministic checks: policy gate (`lib/policy.ts`) and fraud engine (`lib/fraud.ts`): changed payout, duplicate invoice, PO mismatch, lookalike vendor, on-chain counterparty signals (NEAR/EVM RPC), shared blocklist, prompt injection. The first payment to any address is held for a human.
5. Final status is the strictest of all three. The AI can tighten a result, never loosen it. Release re-checks hard rules at that moment.
6. Changed payout → callback to the vendor's **verified channel on file** (never the one on the invoice): Telegram, Twilio voice, or manual. "Not us" → cancel and blocklist.
7. Approved → a real **NEAR Intents (1Click) mainnet quote**. Proofpay holds no treasury key: a signer sends USDC from their own wallet to the deposit address, records the transaction hash, and settlement is confirmed from 1Click. The invoice number and the daily budget stay reserved until it settles, is refunded or expires.
8. Seal the record: hash chain, ML-DSA-65 signature, AES-256-GCM encrypted copy. Auditors get time-limited view keys (`/view`).

## Access control

Everything is behind a signer session (`proxy.ts`) except: sign-in, pay links (clients paying you), Proofpay Check, the public ledger page, `/view` (view-key holders), `/api/openapi`, and the Telegram/Twilio webhooks (each verifies its own secret/signature). Sessions are HMAC-signed cookies; approvals use the signed-in signer, never a name sent by the browser. Policy changes need `APPROVAL_THRESHOLD_SIGNERS` distinct signers.

## What is and is not done

| Piece | Status |
|---|---|
| Policy gate, kill switch, hold window, limits, allowlist | Done, **server-side**, not a contract |
| Signer approvals / policy proposals | Done at application level (named signers with tokens). Not an onchain multisig |
| NEAR AI judgment, signature and attestation checks | Written from NEAR AI Cloud's current verification docs (attestation params, `signature_kind` text formats, raw-byte hashing, `report_data` layout). The endpoints answer (401 without a real key). **Never run end to end with a real key**: response field names beyond what the docs list (for example the encoding of `intel_quote`) may still need adjusting on first run |
| GPU attestation (NVIDIA NRAS) | Implemented per the docs (decoded payload posted unchanged, nonce checked first, overall result must be true). The NRAS JWT signature is not checked locally |
| Intel TDX quote | Verified locally with `@phala/dcap-qvl` (collateral from Phala's PCCS, TCB must be UpToDate). Also done per the docs: echoed `report_data`/`request_nonce` agree with the verified quote, the `event_log` replays to the quote's RTMR3 (`lib/tdx.ts`), and MRCONFIGID binds the raw `app_compose`. These checks are unit-tested against an independent implementation of the documented algorithm, **not against a real NEAR AI report** |
| NEAR AI gateway attestation, TLS binding, image provenance | Not checked. The docs mark them optional depending on policy |
| 1Click quotes and status | Request and response fields match the 1Click API reference (including `depositMemo`, passed on to status checks). `confidentiality` is sent as `basic`/`advanced` exactly as the confidential-swaps page describes. Never executed with funds |
| Sending the funds | **By a human** from their own wallet. The app never holds a treasury key |
| Counterparty signals | Live NEAR/EVM RPC: contract or not, account missing/unused. NEAR account age from NearBlocks (`/v3/accounts/{id}`, `created.block_timestamp`; works without a key at low volume, set `NEARBLOCKS_API_KEY` for more). EVM account age and code-change history are not available and stay unknown |
| Telegram callbacks + replies | Implemented (bot + webhook with secret). Untested against Telegram |
| Voice callbacks | Implemented via Twilio (TwiML Gather, signature-verified webhook). Untested against Twilio |
| Proofpay Check over x402 | Follows the x402 v1 specification: 402 body `{x402Version, error, accepts}`, `X-PAYMENT` is base64 JSON, facilitator `POST /verify` then `POST /settle` with `{x402Version, paymentPayload, paymentRequirements}`; the verdict is only returned once settlement succeeds. The spec lists no NEAR network, so `network: "near"` needs a facilitator that supports it (no PingPay documentation was available to me). Needs `X402_FACILITATOR_URL`. `/api/openapi` describes the endpoint |
| Agent Market worker | `lib/agentmarket.ts` + `POST /api/agentmarket/poll`: lists in-progress assignments, starts them, runs a Proofpay Check on the payee found in the brief or latest buyer message, submits a Markdown verdict (or asks for the payee). Field names are from Agent Market's OpenAPI document. **You still create the listing in their web UI and mint the `aat_` token**; nothing has run against the real service |
| Agent buys an API over x402 | Policy-gated; the signing is delegated to `X402_PAYER_URL` (`POST /pay`) so no payment key lives here. No such service is bundled |
| Receivable pay links | Real 1Click quotes and status polling |
| ML-DSA-65 record signatures, encrypted records, view keys | Done. Keys derive from `PROOFPAY_MASTER_KEY` |
| Persistence | JSON snapshot (`.data/state.json`), single process, no database |
| Rate limiting | In memory, per client and route |

**Out of scope by design (no smart contract, no onchain component of any kind):** onchain anchoring of the record chain, onchain signature verification, an onchain multisig or policy gate, and a meta-transaction relayer. Everything those would do is done in the app server instead, as described above.

**Not built, and why:** Jolt zero-knowledge proof of the policy check (a Rust zkVM; no usable JS/API path), Aurora Intent Connect wallet connect (the pay page shows the deposit address instead), NEAR Business / Trezu integration (no API I could rely on), hosted deployment (a `Dockerfile` is included, untested; mount `/app/.data` and pass secrets as environment variables).

Settled funds on other chains cannot be frozen. Proofpay stops money before it leaves.

## NEAR tools used

| Tool | How Proofpay uses it |
|---|---|
| **NEAR AI Cloud** (private AI, TEE) | The invoice reviewer. The recommendation, its signature and the attestation come from NEAR AI Cloud and are verified in `lib/nearai.ts` and `lib/nearai-core.ts` |
| **NEAR Intents / 1Click** | Payout rail. A mainnet 1Click quote gives the deposit address, status polling confirms settlement, and the same flow powers client pay links for receivables |
| **NEAR mainnet RPC** | Live treasury balance (NEAR and USDC `ft_balance_of`) and counterparty signals for NEAR accounts |
| **x402 on NEAR** | Proofpay Check is sold per call over x402 in USDC on NEAR, and the agent's own API spending is gated by policy |
| **Agent Market** | A worker that answers hired jobs with Proofpay Check (needs your agent listing and `aat_` token) |

Looked at and **not used**: function-call keys, meta-transactions, sub-accounts and named accounts (no contract and no agent key in this build), Chain Signatures, Trezu / SputnikDAO (signers are application-level instead), OutLayer, Aurora, HOT, Rhea.

## Notes

Built with Next.js 16, Tailwind 4, `@noble/curves`, `@noble/post-quantum`, `pdf-lib`. Much of this code was written with AI assistance. Quest (Electric Capital) inspired the redact-before-reasoning step.

License: MIT.
