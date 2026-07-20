import { createHash, randomUUID } from "node:crypto";
import type { ConnectorKind } from "../types/index.js";

const segment = (value: string): string => {
  const normalized = value.trim().replace(/[^A-Za-z0-9@+._-]+/g, "-");
  if (!normalized) throw new Error("Credential reference segment cannot be empty");
  return normalized;
};

const revision = (): string => randomUUID().replaceAll("-", "");

export function connectorCredentialRef(
  role: string,
  kind: ConnectorKind,
  connectorId: string,
): string {
  return `connector/${segment(role)}/${kind}/${segment(connectorId)}.${revision()}`;
}

export function googleClientSecretRef(): string {
  return `oauth/google/client-secret.${revision()}`;
}

export function totpCredentialRef(account: string): string {
  const accountHash = createHash("sha256").update(account.trim().toLowerCase()).digest("hex");
  return `totp/${accountHash}.${revision()}`;
}

export const CONNECTOR_CREDENTIAL_REF_PATTERN =
  /^connector\/[A-Za-z0-9@+][A-Za-z0-9@+._-]*\/(?:mail|calendar|contacts|messenger|files|documents)\/[A-Za-z0-9@+][A-Za-z0-9@+._-]*$/;
export const GOOGLE_CREDENTIAL_REF_PATTERN = /^oauth\/google\/client-secret(?:\.[A-Za-z0-9]+)?$/;
export const TOTP_CREDENTIAL_REF_PATTERN = /^totp\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
