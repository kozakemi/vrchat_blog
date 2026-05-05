import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const b64 = (buf) => Buffer.from(buf).toString("base64");

const k1 = randomBytes(32);
const k2 = randomBytes(32);

const data = {
  schemaVersion: 1,
  username: "Kozakemi",
  roles: ["admin"],
  zones: [
    {
      zoneId: "public-v1",
      keyB64: b64(k1),
      comment: "公开区（示例，可在相册管理页继续新增 Zone）",
    },
    {
      zoneId: "vault-v1",
      keyB64: b64(k2),
      comment: "核心区（示例）",
    },
  ],
  createdAt: new Date().toISOString(),
};

const dir = join(process.cwd(), "keys");
mkdirSync(dir, { recursive: true });
const out = join(dir, "kozakemi.admin.json");
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(out);
