# Zero-knowledge proof of the policy check

A zero-knowledge proof, made with [o1js](https://github.com/o1-labs/o1js) and written entirely in TypeScript, that the policy gate gave the result the app recorded. There is no smart contract and no trusted hardware. The proof is a JSON file that anyone can verify against the circuit's verification key, in Node or a browser, on any OS.

## What is proved

`lib/zk-program.ts` is the policy gate of `lib/policy.ts` written as an o1js program (`ZkProgram`):
- **Checks:** kill switch, per-payment limit, daily limit, permitted chain, permitted asset, vendor allowlist (up to 16 vendors), and the approval threshold.
- **Public statement:** every input, including the policy hash and a `subject` hash naming the payment.
- **Output:** a bitmask, one bit per check.

The app (`lib/zk.ts`) accepts a proof only if all of these hold:
1. o1js verifies it against `zk/verification-key.json`.
2. Its public statement is exactly this payment's.
3. Its output equals the policy check computed again in plain TypeScript.

Hashes enter the circuit as their first 31 bytes (248 bits), so that they fit in a field element.

## Running it

- **In the app:** every payment writes its statement to `.data/zk/jobs/<payment id>.json` and starts a background prover. Only one prover runs at a time, at about 15 s per proof once its keys are cached. The payment page's Verified panel then shows "Zero-knowledge proof of the policy check (o1js)" as verified.
- **In the demo:** `npm run demo -- --zk` proves and verifies the scam invoice's check in the terminal.

```sh
npm run zk:prove            # prove every pending statement (or: npm run zk:prove <payment id>)
npm run zk:verify           # verify all payments' proofs and record the result (or --jobs for every job file)
npm run zk:vk               # recompile the circuit and rewrite zk/verification-key.json after changing it
```

The first compile takes about 20 s. Its prover keys (about 70 MB) are cached in `.data/zk/cache`.

## Zero-knowledge claims (the Proofs page)

Besides the policy proof, `lib/zk-claims-program.ts` has claims that keep something secret: a payee address or a vendor name is not on the OFAC list, a party passed identity verification, the treasury held at least $X (both attested by k of n issuers), and a secret circuit of up to 2,048 gates stays within a qubit and Toffoli bound (recursive proofs). Their verification keys are in `zk/claims-verification-keys.json`. Independent attesters run with `npm run zk:attester` (see `.env.example`).

```sh
npm run zk:claims:vk                     # recompile the four circuits and rewrite the keys after changing one
npm run zk:claim:verify -- proof.json    # verify any claim file on its own (add --issuer <key> and --list-root <root> to pin them)
```

## Tests

`tests/zk.test.ts` makes a real proof and checks five things:
- it verifies for its own payment;
- it is rejected when shown for another payment;
- a tampered output fails o1js verification;
- the committed verification key matches the circuit;
- the circuit's result matches the app's policy gate on eight cases.

## Limits

- **Not private:** every input is public, so the proof shows the check was computed correctly and hides nothing. o1js supports private inputs if some should be hidden later.
- **Not post-quantum:** proofs use o1js's Kimchi proof system on the Pasta curves.
- **Replaces Jolt:** this was first written for the Jolt zkVM, which proves Rust and needs Linux. It was rewritten in TypeScript with o1js so it runs and is tested on any machine.
