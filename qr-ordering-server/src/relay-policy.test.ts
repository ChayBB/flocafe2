import { describe, expect, test } from "bun:test";
import { isRelayPathAllowed } from "./relay-policy";

describe("QR relay path policy", () => {
  test("allows only the FloCafe guest routes and static guest page", () => {
    expect(isRelayPathAllowed("GET", "/api/guest/table")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/guest/menu")).toBe(true);
    expect(isRelayPathAllowed("POST", "/api/guest/order")).toBe(true);
    expect(isRelayPathAllowed("POST", "/api/guest/join")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/server-app/info")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/guest/order")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/server-app/branding/logo")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/server-app/branding/cover")).toBe(true);
    expect(isRelayPathAllowed("GET", "/api/products/prod-1a2b/image")).toBe(true);
    expect(isRelayPathAllowed("GET", "/server-standalone/")).toBe(true);
    expect(isRelayPathAllowed("GET", "/_next/static/chunks/app.js")).toBe(true);
  });

  test("blocks staff, payment, and unapproved guest methods", () => {
    expect(isRelayPathAllowed("POST", "/api/guest/menu")).toBe(false);
    expect(isRelayPathAllowed("GET", "/api/guest/join")).toBe(false);
    expect(isRelayPathAllowed("GET", "/api/orders")).toBe(false);
    expect(isRelayPathAllowed("POST", "/api/auth/login")).toBe(false);
    expect(isRelayPathAllowed("POST", "/api/bills/1/payment")).toBe(false);
    expect(isRelayPathAllowed("GET", "/api/server-app/branding/other")).toBe(false);
    expect(isRelayPathAllowed("GET", "/api/products/prod-1a2b")).toBe(false);
  });

  test("blocks traversal and absolute-URL targets", () => {
    expect(isRelayPathAllowed("GET", "/server-standalone/../api/orders")).toBe(false);
    expect(isRelayPathAllowed("GET", "/api//orders")).toBe(false);
    expect(isRelayPathAllowed("GET", "https://evil.example/api/guest/menu")).toBe(false);
  });
});
