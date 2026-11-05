const guestRoutes: Array<[string, RegExp]> = [
  ["GET", /^\/api\/guest\/(?:table|menu|order)$/],
  ["POST", /^\/api\/guest\/(?:order|join)$/],
  ["GET", /^\/api\/server-app\/info$/],
  ["GET", /^\/api\/server-app\/branding\/(?:logo|cover)$/],
  ["GET", /^\/api\/products\/[\w-]+\/image$/],
];

const staticGuestPath =
  /^\/(?:server-standalone(?:\/[\w.-]*)*|_next\/static\/[\w./@-]+|favicon\.ico|icons\/[\w.-]+|fonts\/[\w.-]+|[\w.-]+\.(?:png|svg|ico|webmanifest|woff2?))$/;

export function isRelayPathAllowed(method: string, path: string): boolean {
  if (!path.startsWith("/") || path.includes("..") || path.includes("//")) return false;
  const verb = method.toUpperCase();
  if (guestRoutes.some(([allowedVerb, pattern]) => verb === allowedVerb && pattern.test(path))) {
    return true;
  }
  return (verb === "GET" || verb === "HEAD") && staticGuestPath.test(path);
}
