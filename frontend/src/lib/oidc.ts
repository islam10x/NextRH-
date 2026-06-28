import { WebStorageStateStore, type User as OidcUser } from "oidc-client-ts";

/**
 * Module-level access-token holder so non-React code (axios interceptors in
 * api.ts) can read the current Keycloak access token. Kept in sync by
 * AuthContext whenever the OIDC user changes.
 */
let accessToken: string | null = null;
export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;

const origin = window.location.origin;

/**
 * react-oidc-context / oidc-client-ts configuration for Keycloak.
 * Authorization Code Flow + PKCE (default for response_type "code").
 * `authority` is the realm issuer; the library auto-discovers the auth/token/
 * jwks endpoints from `${authority}/.well-known/openid-configuration`.
 */
export const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY as string,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID as string,
  redirect_uri: `${origin}/login`,
  post_logout_redirect_uri: `${origin}/login`,
  response_type: "code",
  scope: "openid profile email",
  automaticSilentRenew: true,
  // Per-tab storage, consistent with the previous sessionStorage approach.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Strip ?code & ?state from the URL once the redirect is processed.
  onSigninCallback: (_user: OidcUser | void) => {
    window.history.replaceState({}, document.title, window.location.pathname);
  },
};
