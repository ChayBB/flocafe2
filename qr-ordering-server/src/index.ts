import { PostgresRelayRepository } from "./postgres-repository";
import { createRelayApp } from "./app";

const port = Number(Bun.env.PORT || 8787);
const host = Bun.env.HOST || "0.0.0.0";
const databaseUrl = Bun.env.DATABASE_URL || "";
const adminToken = Bun.env.QR_ADMIN_TOKEN || "";
const publicBaseUrl = Bun.env.PUBLIC_BASE_URL || "";
// Behind Cloudflare the customer's address is in cf-connecting-ip; set CLIENT_IP_HEADER="" when serving directly.
const clientIpHeader = Bun.env.CLIENT_IP_HEADER ?? "cf-connecting-ip";

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (adminToken.length < 24) throw new Error("QR_ADMIN_TOKEN must be at least 24 characters");
if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error("PUBLIC_BASE_URL must use HTTPS");

const repository = new PostgresRelayRepository(databaseUrl);
const app = createRelayApp({ repository, adminToken, publicBaseUrl, clientIpHeader });
app.listen({ port, hostname: host });
console.log(`QR Ordering relay listening on ${host}:${port}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.stop(true);
  await repository.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
