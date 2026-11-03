import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which business a piece of work belongs to. Every request runs inside one business (the session says which), and
 * everything that reads or writes business data (the store, the treasury settings, the team) looks the business up
 * here, so one business can never read or change another's records.
 *
 * "default" is the business of the operator who runs this copy of the app: its settings come from the environment
 * (.env.local), as before. Businesses that sign up on the platform get an id like bz_1a2b3c4d5e and keep their
 * settings in the business registry (lib/business.ts).
 */
export const DEFAULT_BIZ = "default";
export const BIZ_ID = /^bz_[0-9a-f]{10}$/;

const als = new AsyncLocalStorage<string>();

export const currentBiz = () => als.getStore() ?? DEFAULT_BIZ;
export const runAs = <T,>(biz: string, fn: () => T): T => als.run(biz, fn);

/** A public link id (an invoice's pay link, an auditor's key) made inside a business carries its id, so the link finds its business. */
export const scopedId = (id: string) => (currentBiz() === DEFAULT_BIZ ? id : `${currentBiz()}~${id}`);
export const bizOfId = (id: string): string => {
  const [head, rest] = [id.split("~")[0], id.includes("~")];
  return rest && BIZ_ID.test(head) ? head : DEFAULT_BIZ;
};
