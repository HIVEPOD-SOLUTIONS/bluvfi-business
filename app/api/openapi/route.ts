import { bizFromRequest, cfg } from "@/lib/business";
import { runAs } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { NEAR_USDC_CONTRACT } from "@/lib/chains";


/** Machine-readable description of Bluvfi Business Check, for agent marketplaces and other agents' tool discovery. */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const biz = bizFromRequest(req);
  return runAs(biz, () => NextResponse.json({
    openapi: "3.1.0",
    info: { title: "Bluvfi Business Check", version: "1.0.0", description: "Is this payee safe to pay? Pay-per-call over x402 on NEAR." },
    servers: [{ url: biz === "default" ? origin : `${origin}?b=${biz}` }],
    paths: {
      "/api/check": {
        post: {
          summary: "Check a payee before paying",
          description: "Returns 402 with payment requirements until a valid X-PAYMENT header is supplied.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["payoutAddress"],
                  properties: {
                    payoutAddress: { type: "string" },
                    vendorName: { type: "string" },
                    vendorDomain: { type: "string" },
                    amountUsd: { type: "number" },
                    chain: { type: "string" },
                    invoiceText: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Verdict allow | warn | block, with the checks and reasons" },
            "402": { description: "Payment required (x402)" },
          },
        },
      },
    },
    "x-x402": { network: "near", asset: NEAR_USDC_CONTRACT, payTo: cfg().TREASURY_ACCOUNT, maxAmountRequired: "10000" },
  }));
}
