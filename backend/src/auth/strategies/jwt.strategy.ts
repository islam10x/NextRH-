import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { passportJwtSecret } from "jwks-rsa";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../../users/users.service";
import { UserRole, UserStatus } from "../../users/entities/user.entity";

/**
 * Keycloak access token payload (only the claims we read).
 * `sub` is the Keycloak user id — NOT our local user_id.
 * Roles live in `realm_access` (realm roles) and/or `resource_access`
 * (per-client roles), depending on how the realm is configured.
 */
export interface KeycloakJwtPayload {
  sub: string;
  email: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

const APP_ROLES = Object.values(UserRole) as string[];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly clientId?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    const issuer = configService.get<string>("KEYCLOAK_ISSUER");
    const audience = configService.get<string>("KEYCLOAK_AUDIENCE");
    const clientId = configService.get<string>("KEYCLOAK_CLIENT_ID");
    if (!issuer) {
      throw new Error("KEYCLOAK_ISSUER is required");
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ["RS256"],
      issuer,
      // Keycloak puts the client id in `azp`; `aud` may be "account".
      // Audience check is enabled only when KEYCLOAK_AUDIENCE is set.
      ...(audience ? { audience } : {}),
      // Fetch the realm public key from the JWKS endpoint and verify the
      // RS256 signature. Keys are cached so we don't hit Keycloak per request.
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
      }),
    });

    // Used to read client roles from resource_access[clientId].roles.
    this.clientId = clientId ?? audience;
  }

  /**
   * Runs only after signature, issuer, audience and expiry are verified.
   * Maps the verified token to a local user (creating/linking on first login),
   * syncs the role from Keycloak, and returns the object exposed as `req.user`.
   */
  async validate(payload: KeycloakJwtPayload) {
    if (!payload.email) {
      throw new UnauthorizedException("Token has no email claim");
    }

    const role = this.extractAppRole(payload);
    if (!role) {
      // Keycloak is the source of truth for roles, but a misconfigured role
      // mapper shouldn't lock users out — we fall back to the stored role.
      this.logger.warn(
        `No app role in token for ${payload.email}; keeping stored role`,
      );
    }

    const user = await this.usersService.findOrProvisionFromKeycloak({
      sub: payload.sub,
      email: payload.email,
      firstName: payload.given_name,
      lastName: payload.family_name,
      role: role ?? undefined,
    });

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException("Account is inactive");
    }

    // Same shape the rest of the app already expects from req.user.
    return {
      id: user.user_id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
    };
  }

  /**
   * Resolve the app role from the token, tolerant to realm config:
   * client roles (resource_access[clientId]) take precedence over realm
   * roles (realm_access). Returns the first value matching our UserRole enum.
   */
  private extractAppRole(payload: KeycloakJwtPayload): UserRole | undefined {
    const clientRoles =
      (this.clientId && payload.resource_access?.[this.clientId]?.roles) || [];
    const realmRoles = payload.realm_access?.roles || [];
    const match = [...clientRoles, ...realmRoles].find((r) =>
      APP_ROLES.includes(r),
    );
    return match as UserRole | undefined;
  }
}
