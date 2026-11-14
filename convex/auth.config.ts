import type { AuthConfig } from "convex/server";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set on this Convex deployment (npx convex env set ${name} ...)`);
  }
  return value;
}

// Auth0 as an OIDC provider. Convex verifies the ID token's signature against the
// issuer's JWKS, its issuer (domain) and its audience (the Auth0 client ID).
export default {
  providers: [
    {
      domain: `https://${requiredEnv("AUTH0_DOMAIN")}/`,
      applicationID: requiredEnv("AUTH0_CLIENT_ID"),
    },
  ],
} satisfies AuthConfig;
