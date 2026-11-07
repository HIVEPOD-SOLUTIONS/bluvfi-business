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
- **Run it as a platform for many businesses:** in [dashboard.privy.io](https://dashboard.privy.io) create an app, add your app's URL (e.g. `http://localhost:3000`) to its allowed origins, and put the **App ID** and **App secret** (App settings > Basic) in `.env.local` as `PRIVY_APP_ID` and `PRIVY_APP_SECRET`. Restart. The login page then offers "Continue with email or Google". A person whose email is on no business creates one and becomes its owner; one on several chooses which to enter. Each business has its own records (`.data/businesses/<id>.json`), its own team and its own treasury, and nothing one does can reach another: every request runs inside the business of its session (`lib/tenant.ts`), public pay links and auditor view keys carry their business id, and the treasury settings (DAO, agent key, OutLayer key) live in the business registry (`.data/businesses.json`), encrypted under `BLUVFI_MASTER_KEY`, never in `.env.local` and never inherited from another business. After signing up, the owner opens **Set up your treasury** and their own wallet creates their DAO and agent (`/setup`); until then payments cannot be sent. The owner adds approvers on the **Team** page; removing someone ends their session at once. Your own business (the one `.env.local` configures, with `BLUVFI_SIGNERS` and/or `BLUVFI_OWNER_EMAIL`) keeps working as before. `BLUVFI_SIGNUP=closed` stops new signups. The server verifies Privy's signed token (ES256, against the app's JWKS) and reads the person's verified email with the secret, which never reaches the browser. A policy change still needs `APPROVAL_THRESHOLD_SIGNERS` (default 2) different signers, so an owner should add a second person. Tested in `tests/privy.test.ts` and `tests/business.test.ts` against a local server speaking Privy's two endpoints with a real ES256 key; not run against Privy's own servers, so the first live sign-in is the check. **Channels are per business too** (**Settings**, owners only): each business connects its own Telegram bot (we register the webhook, `/api/telegram/webhook?b=<id>`, with a secret made for that business), its own Twilio account for voice callbacks, its own Agent Market worker (`/api/agentmarket/poll?b=<id>` with that business's cron secret), and its own PingPay key or x402 facilitator, so what its public **Check** service (`/api/check?b=<id>`, `/check?b=<id>`) earns settles to its own treasury. Each business's blocklist and check log are its own, and its public ledger is at `/ledger?b=<id>` once it switches transparency on. Replies are verified with that business's own secret or token, so a reply through one business's bot can never touch another's payments. Secrets are encrypted at rest and never shown again. Still the platform's: the relayer that pays gas for gasless votes, and the AI, 1Click and zero-knowledge services every business uses.
- **What's missing:** the Overview lists any unset variables, and the custody card says whether the agent's credential is really scoped.
- **Set up a real treasury from the browser:** run `npm run dev` with no custody settings and open `/setup`. Enter the one-time setup code printed in the terminal (needed until signers exist), connect your NEAR wallet, name the treasury and its council, and click **Sign in wallet and finish**. Your wallet signs two calls: `create_account` on `near` for the agent account (0.3 NEAR) and `create` on `sputnik-dao.near` for the DAO (6 NEAR, kept by the DAO). The server, holding only the agent's own key, then locks the agent to one `add_proposal` key, deletes its full-access key and writes `.env.local`, making signer tokens if you have none (shown once). Restart the app to load them. Your wallet key never reaches the server (`lib/setup.ts`, `app/setup`). With `PRIVY_APP_ID` set, the page also offers **email or Google** through [Privy](https://www.privy.io/): Privy creates a NEAR wallet for the person, shows its address to fund, and signs the same two calls with its embedded wallet (`app/setup/PrivyPayer.tsx`, after NEAR's `hello-privy` example).
- **Or in one command:** `npm run mainnet:setup -- --funder you.near --council you.near,partner.near --name yourteam` prints the plan and costs (about 6.3 NEAR, most of it kept by the DAO itself) and sends nothing. Add `--yes`, with `MAINNET_FUNDER_KEY` set to a full-access key of `--funder`, to create the agent account, a Sputnik DAO (your council executes on a majority, the agent is its only Requestor, proposal bond 0), lock the agent down to one `add_proposal` key and fill in `.env.local`. The funding key is read from the environment only; the agent's keys go to `.mainnet/` (git-ignored).
- **Safe for judging:** set `ONECLICK_DRY=1` to get real 1Click prices with **no deposit address**, so nothing can be paid.

## How a payment moves

`lib/agent.ts` holds the whole pipeline.

1. **Redact before reasoning.** NEAR AI Cloud's `POST /v1/privacy/redact` (`openai/privacy-filter`, inside its TEE gateway) strips names and bank details, then local patterns strip wallets and handles. If the filter is down, only the patterns run and the record says so. This is Electric Capital's Quest principle.
2. **Signed judgment.** A private model on NEAR AI Cloud reviews the redacted invoice. The attestation is fetched with our own nonce, then the completion, then the response signature (`lib/nearai.ts`). We verify:
   - the reply is the **structured decision**: the request carries the decision as a JSON schema (`response_format`, strict), and the reply must be exactly one object matching it (`pay`/`hold`/`block`, an integer risk score 0–100, a summary and reasons; no extra fields). If NEAR AI does not take `response_format` for the model, the review is asked once more without it, the schema is still enforced here, and the record says so;
   - the signed text matches the exact request and response bytes for the `signature_kind`;
   - the ed25519 signature;
   - exactly one attestation report vouches for the signer;
   - the Intel TDX quote, with dcap-qvl (TCB UpToDate), its report_data binding, RTMR3 replay and MRCONFIGID;
   - the NVIDIA evidence, via NRAS, **and NVIDIA's signed verdict itself** (`lib/nras.ts`): the ES384 signature against NVIDIA's published keys, the issuer, the expiry, our nonce and the overall result.

   The raw attestation report is kept by its hash in `.data/attestations/`, and the record points at it, so an auditor can verify the exact evidence again. If anything fails, the payment is **held for a human**, never paid.
   - **At setup** (Overview → *Private AI model* → **Verify the model now**, or `npm run ai:verify`): the attestation is fetched with a fresh nonce and every model instance's Intel TDX, NVIDIA and key binding are checked, with no inference spent. The signing keys that pass are registered, and each payment's Verified panel says whether its signer was one of them.
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

### Who holds which key

The treasury itself has **no private key**: it is a Sputnik DAO contract, and only the council's onchain vote moves it. Every other key the app touches, where it lives, and what it could lose if it leaked:

| Key | Where | What a leak could do |
|---|---|---|
| Agent key | `.env.local`, or the business registry encrypted under the master key | Nothing with money: it can only *propose* (checked from the chain before every payout) |
| Council votes | The council member's own wallet; nothing in the browser | — |
| OutLayer API key | `.env.local`, or encrypted per business | Spend from the spending wallet **up to OutLayer's own limits**, which the app now **requires** (`REQUIRE_CUSTODIAN_LIMITS`, on by default) |
| Relayer key | `.env.local` (must be full-access to relay) | Its own NEAR, which the custody check keeps to a gas budget (`RELAYER_MAX_NEAR`, default 5) |
| Master key | `BLUVFI_MASTER_KEY_FILE` (a mounted secret), or `BLUVFI_MASTER_KEY` | Decrypts every business's stored keys. In production, mount it from a secrets manager, not `.env.local` |
| x402 payer, confidential-test account | `.mainnet/*.json` (`.testnet/` for the test payer), sealed under a passphrase (lib/keyfile.ts); mainnet refuses plain text. Managed on the **Wallets** page (platform operator only): create, see address, balance and spending, encrypt an old plain file, show the payer's token. The passphrase is typed for each action and never stored | Their own small balances, and only with the passphrase |
| Agent setup keys | `.mainnet/agent.json` while setup runs, encrypted when a master key exists; **deleted when setup finishes** | Before finishing: the agent account's 0.3 NEAR |
| Your funding wallet, Privy wallets | Your wallet; Privy's embedded wallet | Never seen by the app |


- **The agent cannot move funds.**
  - **Sputnik:** the agent key is a NEAR **function-call access key** limited to `add_proposal` on the DAO. Such a key can attach no deposit, so the DAO's bond must be 0.
  - **The agent holds only that key.** Every key on the agent account must be one that can call `add_proposal` on the DAO and nothing else. A full-access key, or a key for any other contract or method, fails the check, and the Overview shows the `near account delete-keys` command to remove it. So no one, the agent included, can transfer from the agent account, add keys, deploy code or vote with it.
  - **The app verifies this from the chain** (`view_access_key`, `view_access_key_list` and the DAO's `get_policy`) and refuses to submit payouts if any key is full-access or scoped to anything else, if the agent's DAO role can vote, if the relayer account can vote, or if the bond is not 0 (`lib/custody.ts checkCustody`). The DAO roles mean the agent can propose but never approve a payout or change the DAO's policy.
  - **`add_proposal` is our `request_payment`.** The spec names a contract method `request_payment`; with an existing DAO, filing a proposal is that request, and the council's vote is the approval.
  - **OutLayer:** the agent holds only an API key, and the app refuses a wallet with no stored policy.
  - **Hybrid:** both checks must pass, **and** OutLayer must cap each payment at the approval threshold or less. Otherwise the app refuses to pay. So a large payment routed to the wallet, by a bug or a compromised server, is refused by OutLayer, and can only leave through a council vote. The spending wallet's balance, read from the chain, is the most that can ever leave without one.
  - **Post-quantum option:** the agent key may also be ML-DSA-65 (`ml-dsa-65:`), which NEAR and near-api-js support. NEAR lists such keys as `ml-dsa-65-hash:…` (the SHA3-256 of the key), and the custody check reads both forms.
- **Gas allowance lock-out.** A function-call key whose gas allowance runs out stops working. Because the agent account has no full-access key, it cannot add a new key itself: the account is locked. Nothing is lost, since the agent account holds no treasury funds. The fix is a new agent account with a fresh scoped key, which the council swaps into the agent's DAO role. The custody check warns when the allowance is nearly used. A key added with no allowance limit draws gas from the account's own NEAR balance instead, so keep a little NEAR there.
- **Kill switch.** It stops this app immediately. For a hard stop onchain, the Overview shows the `near account delete-keys` command that revokes the agent's key. The council can also reject or remove open proposals.
- **Council votes.** A council member votes from the payment page with **their own NEAR wallet**; no key is kept in the browser (`components/GaslessVote.tsx`). If the wallet can sign a NEP-366 delegate action and a relayer is configured, the vote is gasless; otherwise the wallet sends it directly. (An earlier version kept an `act_proposal` key in `localStorage`, where any script on the page could read it and vote; the page now deletes such a key on sight and shows the command to remove it from the account.) Before anything is relayed (`relayVote`), the relayer checks that it is:
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
  - **NVIDIA's verdict:** its JWT signature is checked locally against NVIDIA's published key set (fetched over TLS). The key's certificate chain to NVIDIA's root is not walked.

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
| Optional privacy, as policy | A **privacy floor** in the hashed policy (`public` = none, `basic`, `advanced`). Every payment is raised to at least the floor, at intake and again at release, and the payment shows a "Privacy floor" check when it was raised. At `advanced` (NEAR Intents confidential), the DAO payout proposal leaves the vendor, invoice and payee out of its public description: it carries only the payment id, the 1Click deposit address and the evidence hash. The USDC amount sent to the deposit address is still visible onchain | App gate; confidential delivery by NEAR Intents |
| Post-quantum keys for whoever can move the money | The custody check reads every council member's keys from the chain (`view_access_key_list`) and reports which hold only ML-DSA (lattice, FIPS 204) full-access keys, and whether the agent and relayer keys are ML-DSA. With **Require post-quantum keys** on in the policy, payouts stop until all of them are, because a quantum computer that breaks ed25519 could forge a council vote from any classical key | Checked from the chain |
| Function-call key lock-out | A function-call key whose gas allowance runs out stops working until the owner adds a new one. The custody check warns when the allowance is nearly used | Checked from the chain |

**Trezu note:** a Trezu treasury has the roles Requestor (creates payment requests, cannot vote), Finance (votes on payments) and Governance (members, voting rules, policy). Put the agent in **Requestor only**. Trezu creates DAOs with a 0.1 NEAR proposal bond, which a function-call key cannot attach, so a Governance proposal must set the bond to 0 first; the custody check says so until it is done.

**Hybrid custody closes most of that gap without a contract:** routine payments come from a wallet whose limits OutLayer enforces in a TEE, and whose balance is a hard ceiling; everything larger goes to the council. What stays app-only is the hold window and the vendor allowlist for DAO payouts.

What this does **not** give you, and cannot without writing a contract: with Sputnik custody, a compromised app server could ignore its own limits, allowlist and hold window, because a DAO enforces votes, not amounts or delays. The council reviewing each proposal is the backstop, and revoking the agent key is the hard stop. OutLayer's policy is the option that enforces limits outside this app. While the kill switch is on, the Overview lists payouts still waiting onchain, with links to reject them; the agent cannot withdraw them itself.

### Layer 1 tested for real (nothing mocked)

Two suites run against real services; neither uses a fake RPC, a fake DAO or a fake API.

```bash
npm run test:real                       # the gate rules through the real pipeline: real 1Click dry-run quotes, real payee lookups
npm run testnet:keys && npm run testnet:setup   # once: throwaway testnet accounts, a real Sputnik DAO, a locked-down agent
npm run test:testnet                    # Layer 1 against that DAO and OutLayer's testnet API
```

`testnet:setup` creates five named testnet accounts (NEAR's testnet account helper funds each with 10 NEAR), a real DAO from the `sputnikv2.testnet` factory (a 3-member council that executes on 2 votes, an agent in a Requestor role, proposal bond 0), and gives the agent account one function-call key (`add_proposal` on the DAO) after deleting its full-access key. `BLUVFI_NETWORK=testnet` points the app's NEAR side at testnet. What the testnet suite proves, with real transactions signed by the real council keys:

- the custody check passes on the real DAO and reads its true 2-of-3 threshold;
- the agent's key cannot vote, transfer, add keys or file a policy change, because **the chain rejects each attempt**;
- the agent files a policy change, the council approves it onchain, and the app applies it only then; a rejected change never applies;
- a payout proposal lands on the DAO with its evidence, and the council's rejection is followed;
- the council's hard stop works: the agent is removed from its role, the custody check fails and the agent's key can no longer propose; the role is then restored;
- a gasless vote: a council member signs a NEP-366 delegate action and the relayer pays the gas.

Testing against the real thing found three bugs that the mocked tests had hidden, all fixed: an approved policy proposal could be **replayed** against a fresh app state (approvals are now bound to the exact policy they replace and must be filed after the draft); the relayer treated the agent's Requestor role as part of the council (it now relays only votes from roles that can vote); and a not-yet-final DAO view failed with an unclear error.

What cannot be tested on testnet, and so is not: **1Click, NEAR AI Cloud and NVIDIA NRAS have no testnet**, so `test:real` uses 1Click's real mainnet dry-run quotes and leaves the AI key unset (the review then genuinely cannot run and payments are held for a human). A real 1Click quote refuses confidential (`basic`/`advanced`) payments without `ONECLICK_JWT`, and refuses a refund account that does not exist. **OutLayer's policy can only be set by its owner in OutLayer's dashboard, which only opens mainnet wallets** (a testnet wallet's key is rejected as "Invalid or revoked API key"). The policy tests therefore live in `tests/real/outlayer.test.ts` and read an empty mainnet wallet (`.testnet/outlayer-mainnet.json`, nothing funded, nothing sent); the limit-sync test is skipped, with its reason shown, until its owner has set a policy. The older mocked tests (`custody`, `hybrid`, `outlayer`, `integrations` and others in `tests/`) still run under `npm test`.

### No contract, so no contract audit

This build deploys **no smart contract**, so there are no contract audit findings to report. Custody uses audited, widely deployed code instead: Sputnik DAO v2 (what Trezu runs) or OutLayer. What we check about that setup at runtime is listed under *Security model*.

## What is and is not done

| Piece | Status |
|---|---|
| Fraud checks, policy gate, kill switch, hold window, callbacks, blocklist | Done, unit-tested. Counterparty signals (including a contract's code changing in the last 30 days, from an archive node) and the voice callback's speech-to-text (real Whisper on NEAR AI) run against the real services in `tests/real/layer4.test.ts`; Telegram and Twilio need your own accounts |
| NEAR AI signature + TDX + NVIDIA verification | Written to NEAR AI's verification docs and unit-tested against an independent implementation; NVIDIA's signed verdict is checked locally; the decision is structured output, enforced. **Not yet run end to end with a real key:** run `npm run ai:verify -- --review` with one (a few cents of credits), then `npm run fixtures:record` |
| NEAR AI privacy filter (`/v1/privacy/redact`) | Done, and run against the live endpoint (`tests/real/layer5.test.ts`): name, email, phone, IBAN, wallets and handle are removed, the amount is kept |
| Privacy for those who need it | The council sets who needs privacy as policy (hashed, so changing it needs the same approvals as any limit): a treasury type (open, startup, organisation or institution, investor or holder), a floor, amount tiers and named vendors. A payment goes out at the highest level any rule asks for, and says which rule raised it (`lib/privacy.ts`, `tests/privacy.test.ts`). Open treasuries stay open |
| Sanctions screening | Every payee is checked against the US OFAC SDN list (downloaded from the Treasury, refreshed daily, `lib/sanctions.ts`): a listed payout address **blocks**, a listed or near-matching name **warns**, and the check runs again at release. Run against the real list in `tests/real/sanctions.test.ts`. If the list is unavailable the payee is reported as not screened, never as clear |
| Identity verification (KYB) | Vendors and signed-up businesses verify through Persona (`lib/kyb.ts`): a hosted link, a signed webhook, and the decision confirmed with Persona's API. `KYB_REQUIRED=1` stops an unverified business paying. Tested against a local Persona-shaped server; a real run needs your Persona account |
| Tiered verification | **The council decides who verifies, and when**, in the hashed policy (Policy page, `lib/verify-tiers.ts`): vendors from an amount (default $5,000, the approval threshold), new vendors before their first payment, this business from an amount or for confidential payments, and whether a passport proof counts. Below the rules nobody is asked for anything, so most users never submit a document. A policy from before tiers keeps the old rule (unverified warns). Tested |
| Short retention | Once Persona's decision is final, the app asks Persona to delete the documents after `PERSONA_REDACT_AFTER_DAYS` (default 7) with `DELETE /api/v1/inquiries/{id}`, which permanently removes the inquiry's personal data; only the decision stays, and the Vendors and Team pages say when the documents were deleted. Runs after each Persona webhook and on the scheduled settlement poll. Tested against a Persona-shaped server; a real run needs your Persona account |
| One-time cards for the agent | For purchases behind an ordinary card checkout (a domain, a SaaS seat, a dataset), the agent asks for **a virtual card made for that one purchase** (`lib/cards.ts`, **Cards** page, `POST /api/cards`). The policy decides first: kill switch, a council-set card budget per day, the per-payment and daily limits, the domain blocklist and an OFAC screen of the merchant; from the approval threshold up, signers approve. The issuer caps the card at the amount for its whole life; the number is handed over once and never stored; unused cards close after 24 hours and the kill switch closes them all. Three issuers: **Stripe Issuing** (with real-time authorization: every charge is approved or declined here, first charge only, within the amount), **Ramp** Agent Cards (Vault API) and **Rain** (stablecoin-backed; card numbers come back encrypted under a key only this app holds). **Every business uses its own card-issuing account**, connected by an owner on the Settings page (keys encrypted at rest); its Stripe webhook carries `?b=<id>` and only that business's signing secret is accepted, so no business's cards are charged to another's account. Tested against local servers that speak each API; a real run needs an issuing account |
| Passport proofs (no documents) | **Self** (self.xyz), through its enterprise API (`@selfxyz/enterprise-sdk`; Self's open SDK is deprecated): a hosted link, the Self app reads the passport chip and proves in zero knowledge "real passport holder, of age, not on OFAC lists", sharing no name, number or document (`lib/passport.ts`). The webhook's Svix signature is checked, then **the proof is re-verified here** with Self's verifier before it counts. Its nullifier stops one passport verifying two parties. Only the checked predicates are kept. Tested with Self's real SDK (signature and replay checks) and faked proofs; a real run needs a Self account and a passport (or its test environment, `SELF_ALLOW_TEST=1`). Self's SDK is licensed BUSL-1.1 (source-available; it becomes Apache 2.0 in 2029) |
| Zero-knowledge claims | The Proofs page makes o1js proofs that state one true thing and keep the rest secret: a payee address is not on the OFAC list, a vendor name is not on it (exact match over every listed name and alias), a vendor or business passed verification, the treasury held at least $X (each attested by k of n independent issuers: this app plus attesters that check the chain or Persona themselves, `npm run zk:attester`), and a secret circuit of up to 2,048 gates uses at most Q qubits and T Toffoli gates (recursive proofs, a chunk of 32 gates at a time). The issuer set can be put to the DAO and recorded on chain once the council approves it. A proof is a file anyone can check on the public `/verify-proof` page (paste or choose it, no account), with `npm run zk:claim:verify -- proof.json`, or by POST to `/api/claims/verify`. Run for real, including the whole real OFAC lists, a real mainnet balance read by two issuers and the anchor on the real testnet DAO. Still trust-based: balances and credentials rest on the issuers (no light-client proof), and the circuit claim is a bound on a committed gate list, not a proof of a full-scale circuit's cost. Kimchi proofs are not post-quantum (`lib/zk-claims.ts`) |
| Records at rest | Sealed: every business's records and the business list are one AES-256-GCM blob under a key derived from `BLUVFI_MASTER_KEY` (`lib/vault.ts`). Old plain files are sealed on first read; a changed or wrongly keyed file is refused. Keep `BLUVFI_MASTER_KEY` safe: without it the files cannot be read |
| Sputnik DAO custody (scoped key, proposals, status) | Done, tested against a mocked NEAR RPC. **Not yet run on mainnet** |
| Gasless council votes (NEP-366 relayer) | Done. Relay guards are tested; browser signing has not been run against mainnet |
| OutLayer custody | Done to OutLayer's OpenAPI document, tested with mocks. **Not yet run against OutLayer** |
| Hybrid custody (DAO vault + OutLayer spending wallet) | Done: routing by size and balance, the combined custody check, top-up proposals, both balances on the Overview (`tests/hybrid.test.ts`). Tested against a mocked NEAR RPC and OutLayer API. **Not yet run on mainnet or against OutLayer** |
| 1Click payouts and payment links | **Run against the real 1Click API, with no funds** (`npm run test:real`, `tests/real/layer3.test.ts`): real quotes to every chain the policy can allow (NEAR, Ethereum, Base, Arbitrum, Solana), real quotes for payment links from each of them, a live deposit address whose status is `PENDING_DEPOSIT`, the deposit-hash report accepted, and an unknown address refused. Built from what the live API showed: the quote's deadline sets how long the deposit address works (a DAO payout asks for the council's whole voting period plus a day, because funds sent to a dead address can be lost; the council is shown the date in the proposal), a signer's reported transaction hash is sent to 1Click, every 1Click status is handled for payment links (processing, a short deposit, refunded, failed, expired), and `POST /api/settlement/poll` settles open payouts and links on a schedule (bearer `SETTLEMENT_CRON_SECRET` for every business, or a signed-in signer for their own). **Never executed with funds** |
| Whisper voice answers | Done to NEAR AI's API reference; not run against Twilio or NEAR AI |
| Check over x402 | **PingPay Agent Pay** (x402 v2: buyers pay USDC on Base, we receive USDC on NEAR through NEAR Intents), or any x402 v1 facilitator that supports `near`. PingPay routes and shapes were checked against its docs and live endpoints on 2026-11-01 (and `/supported` again on 2026-11-04, when the production host `https://pay.pingpay.io` began serving it too; `tests/real/layer3.test.ts` checks it live): `https://staging.pingpay.io/agentpay/x402/supported` answers as documented and `prepare` requires a key; the documented `https://pay.pingpay.io` did not yet serve these routes. The app checks `/supported` before taking payments. **Not yet run with a funded payment** |
| Agent Market worker | Done (`lib/agentmarket.ts`). You still create the listing and token in their UI |
| Agent buys APIs over x402 | Policy-gated, and now with a **payer service you run** (`npm run x402:payer`), because the app holds no payment key. It is a separate process with a small wallet and its own rules the app cannot change: a shared secret, USDC on Base only, testnet by default (`--mainnet` for real money), a per-payment cap (default $0.05) and a daily cap (default $1) that survives restarts. The signature is an EIP-3009 authorisation (`lib/x402-signer.ts`), checked by recovering its signer with a separate call. **Run against the real x402.org test API and its real facilitator on Base Sepolia** (`tests/real/x402.test.ts`): the API's price is read from its v2 header, the facilitator accepts our signature (an unfunded wallet is refused only for its balance, and a corrupted signature reads differently), and the agent signs exactly $0.01 within its limits. **Paid for real on 4 November:** with 20 free test USDC from https://faucet.circle.com in the payer's wallet, the same test made real payments of 0.01 USDC to the API through the payer, within its limits, and the API delivered (the wallet's balance fell by exactly that). Not yet run on mainnet |
| Receivable pay links | With `AURORA_API_KEY`, **Aurora's Intents swap widget**: the client connects any wallet (EVM, Solana, NEAR, Stellar) and pays with the token they hold. Every quote comes from our server (`fetchQuote`), which forces the invoice amount (EXACT_OUTPUT), USDC on NEAR and our treasury, so the widget sends exactly that quote to a 1Click deposit address we then track. Renders and quotes in the browser; **not yet paid from a real wallet**. Without a key, a deposit address to send to by hand |
| Confidential treasuries (the layer under NEAR Business and Trezu's confidential treasuries) | **Built and tested end to end except a funded payout.** `CONFIDENTIAL_TREASURY=1` (or, for a business that signed up, **Make this a confidential treasury** on the Overview) makes a Sputnik DAO's shielded balance the source of payouts. The DAO has no key, so everything is signed by NEAR's MPC signer after the council approves a proposal the agent files: the **login** (about weekly; its tokens are kept encrypted and refreshed on their own) and each **payout** (the proposal carries only a hash, so the public proposal does not name the payee or the amount). **Getting funds in** is in the app too (Overview, Confidential treasury, Shielded balance): one council-approved proposal deposits the DAO's USDC to its Intents balance, a second signs the shield that moves it into the shielded balance, 1:1 with no fee. When the council approves, the app finds the signature from the vote through FastNEAR's transaction index (no explorer key), verifies it against the DAO's derived key and the exact hash, submits the intent to 1Click, and settles from 1Click's confidential status. `lib/confidential.ts`, `lib/confidential-flow.ts`. **Checked live:** the NEP-413 login, token refresh, balance read, refusals, and the whole payout path with your 1Click partner key on a throwaway account (quote, intent, signature, submission, then `FAILED` with nothing moved) on both the test host and mainnet (`tests/real/confidential.test.ts`); the MPC signing of a hash through a real testnet DAO, and finding that signature from the index (`tests/testnet/confidential.test.ts`). **Tested with a local stand-in for the three services, shaped as the live ones behaved:** the whole app flow, including a wrong hash or key being refused (`tests/confidential-flow.test.ts`). **Not yet run:** a payout that actually delivers, and the shield, a DAO's login and a DAO's payout on mainnet. They need real funds, which only you can send: `npm run confidential:test` runs the deposit, shield and payout on a throwaway account with about $2, and the Overview runs the same for a DAO. **Does it work with a NEAR Business or Trezu treasury, without early access?** Check any of them yourself: `npm run confidential:check -- <dao> [--agent <account>]` (the DAO account is in the treasury's address in Trezu). Such a treasury is a public Sputnik DAO, so the check reads everything that matters from the chain, read-only: its policy and bond, whether the agent can file proposals into it without being able to vote, the key NEAR's MPC signer derives for it, and the signing requests its council has already approved, compared field by field with what this app files, with each signature verified. It cannot see the shielded balance or the 1Click login, which only the council can open. **Run against a real production confidential treasury on mainnet, `brqm8.sputnik-dao.near`** (`tests/real/confidential-compat.test.ts`): its login proposal is the one this app files (same signer, method, 1 yoctoNEAR, 250 Tgas, path and domain), its council's signature is on the chain and verifies under the DAO's key, and its policy has the Requestor role the agent needs with a zero bond. Confidential routing costs more than a public payout (about 13% over on a $5 payment). 1Click's test host also accepts a replayed login and ignores the login message's own deadline |
| NEAR Business / Trezu | Agent proposals use Trezu's own description format (`* Proposal Action: payment-transfer <br>* Title: … <br>* Recipient: … <br>* Destination Network: …`), so they appear in Trezu as **Payment Requests** to the vendor, with the deposit address and quote signature, deep-linked at `https://trezu.app/<dao>/requests/<id>`. NEAR Business has no public API and its treasuries are confidential (private shard), so the agent cannot propose into one; a public Sputnik DAO opened in Trezu is the supported target |
| ML-DSA-65 records, encrypted records, view keys | Done |
| Demo mode, fixtures, hosted demo | `npm run demo`, `npm run demo:ui`, Docker with `BLUVFI_DEMO=1` (`npm run demo:serve`) |
| Zero-knowledge proof of the policy check | Written in TypeScript with **o1js** (`lib/zk-program.ts`): the policy gate as a ZK circuit. Every payment's statement (amounts, limits, chain, asset, allowlist, policy hash, payment) is proved in a background process (~15 s) and verified on the payment page against the committed verification key (`zk/verification-key.json`), plus a check that the proof's statement is this payment's and its output equals the policy result. Runs on Windows, macOS and Linux; tested with real proofs. `npm run demo -- --zk` shows it. See `zk/README.md` |
| Post-quantum policy check | Every payment's policy check (the same public statement the o1js proof uses) is signed at intake with **ML-DSA-65** (lattice, FIPS 204) and **SLH-DSA-SHA2-128f** (hash-based, FIPS 205; secure as long as SHA-256 is), in `lib/pqcheck.ts`. The payment page and `npm run zk:verify` re-run the check from its public inputs and verify both signatures against this app's keys. Forging it needs a break of both lattices and hashes. It is post-quantum where the o1js proof (elliptic curves) is not. It is not zero-knowledge, which hides nothing here because every input is public. A post-quantum ZK proof (Lattice Jolt, or a hash-based STARK) needs a Rust toolchain and stays on the roadmap |
| Persistence | JSON snapshot (`.data/`), single process, no database |

**Not built, and why:**
- **Our own smart contract:** out of scope by choice; custody is Sputnik or OutLayer instead.
- **Proposing into a NEAR Business confidential treasury:** no public API, and those treasuries live on a private shard. Public Sputnik DAOs in Trezu are supported instead (see above).

## NEAR tech used, and why

| Tool | How Bluvfi Business uses it |
|---|---|
| **NEAR AI Cloud** (private models in TEEs) | The invoice reviewer, with attestation and signature checks. It also runs the privacy filter before reasoning and Whisper for voice callbacks |
| **Function-call access keys** | The agent's only credential: `add_proposal` on the DAO and nothing else. Council members vote with their own wallets |
| **Sputnik DAO / Trezu** | Treasury custody and multisig. We don't rebuild the multisig; the agent proposes Payment Requests in Trezu's format and humans vote |
| **Aurora Intents swap widget** | Clients pay invoices from any wallet and token; amount, asset and recipient are fixed by our server |
| **Meta transactions (NEP-366)** | Gasless council votes through a relayer that only relays votes |
| **NEAR Intents / 1Click** | Cross-chain payouts in USDC to vendors on Base, Arbitrum, Ethereum, Solana and NEAR, with per-payment confidentiality. The same flow powers client pay links |
| **OutLayer** | Alternative custody, or the spending wallet in hybrid custody: a policy wallet whose limits and approvals are enforced in Intel TDX |
| **x402 (PingPay Agent Pay)** | Check sold per call; the agent's own API spending is gated by the same policy |
| **Agent Market** | A worker that answers hired jobs with Bluvfi Business Check |
| **NEAR RPC / NearBlocks** | Treasury balances, counterparty signals, and onchain custody checks |
| **ML-DSA** | Post-quantum record signatures. Agent and council keys may be ML-DSA-65 (`ml-dsa-65:`) |

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
npm run ai:verify -- --review   # Layer 2 against the live NEAR AI Cloud: attestation, NVIDIA, signature, structured decision (needs NEAR_AI_API_KEY)
npm test         # 135 tests; outside services are mocked inside tests/ only
npm run demo     # the end-to-end story; exits non-zero if an outcome or a signature is wrong
```

License: MIT (see `LICENSE`).
