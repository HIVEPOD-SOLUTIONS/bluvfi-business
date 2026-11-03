import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { addMember, members, removeMember } from "@/lib/team";

export const GET = route(async (req) => {
  await requireSigner(req);
  return { members: members() };
});

export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const { email, role } = await body<{ email?: string; role?: string }>(req);
  return { member: addMember(by, String(email ?? ""), role === "owner" ? "owner" : "approver") };
});

export const DELETE = route(async (req) => {
  const by = await requireSigner(req);
  const { email } = await body<{ email?: string }>(req);
  removeMember(by, String(email ?? ""));
  return { ok: true };
});
