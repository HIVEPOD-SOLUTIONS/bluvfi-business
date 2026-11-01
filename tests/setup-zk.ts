// Proofs and compiled keys for tests/zk.test.ts live in the OS temp folder, kept between runs, out of the repo.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BLUVFI_ZK_DIR = join(tmpdir(), "bluvfi-zk-test");
