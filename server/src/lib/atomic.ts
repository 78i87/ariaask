import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Write a file atomically: write to a unique temp sibling, then rename over the target. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
