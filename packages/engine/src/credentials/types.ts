export type CredentialType =
  | "oauth2"
  | "api-key"
  | "basic"
  | "bot-token"
  | "custom"
  | string;

export interface ToolCredentialBinding {
  required: boolean;
  type: CredentialType;
  requiredScopes?: string[];
  showInForm?: boolean;
}

export interface ResolvedCredential {
  id: string;
  type: CredentialType;
  secret: Record<string, unknown>;
  displayName: string;
  scopes?: string[];
}
