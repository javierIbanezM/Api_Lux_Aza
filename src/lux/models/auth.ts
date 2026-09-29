/** Modelos de autenticacion de la API LUX. Ver docs/lux-api-analysis.md §2. */

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  name: string;
  token: string;
  refreshToken: string;
  issuedAt: string;
  expiresAt: string;
  permisos: string[];
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

/**
 * TODO — INFORMACION NO DEFINIDA EN LA DOCUMENTACION: el PDF no confirma si la respuesta de
 * /login/refreshToken incluye un nuevo refreshToken o solo un nuevo token. Se modela como
 * "al menos token", con refreshToken y expiresAt opcionales.
 */
export interface RefreshTokenResponse {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
}
