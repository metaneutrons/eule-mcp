import { z } from "zod";
import type { AppConfig } from "../types/index.js";

export const CONNECTOR_KINDS = [
  "mail",
  "calendar",
  "contacts",
  "messenger",
  "files",
  "documents",
] as const;

export const CONNECTOR_TYPES = [
  "m365",
  "imap",
  "caldav",
  "carddav",
  "ical",
  "signal",
  "google",
  "paperless",
] as const;

const id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const account = z.string().trim().min(1).max(320);

export const connectorSchema = z
  .object({
    id,
    type: z.enum(CONNECTOR_TYPES).default("m365"),
    account,
    mailbox: account.optional(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    smtpHost: z.string().trim().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    auth: z.enum(["oauth", "password"]).optional(),
    password: z.string().optional(),
    url: z.url().optional(),
    token: z.string().optional(),
    signalCliUrl: z.url().optional(),
  })
  .strict();

const connectorGroups = z.object(
  Object.fromEntries(
    CONNECTOR_KINDS.map((kind) => [kind, z.array(connectorSchema).optional()]),
  ) as Record<(typeof CONNECTOR_KINDS)[number], z.ZodOptional<z.ZodArray<typeof connectorSchema>>>,
);

const roleSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(200),
    weeklyHours: z.number().min(0).max(168),
    contexts: z.array(z.string().trim().min(1).max(128)).default([]),
    connectors: connectorGroups.default({}),
    signature: z.string().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    policy: z
      .object({
        enabled: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        allowedConnectorKinds: z.array(z.enum(CONNECTOR_KINDS)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    language: z.enum(["de", "en"]).default("de"),
    oauth: z
      .object({
        clientId: z.string().trim().min(1),
        tenant: z.string().trim().min(1),
        apiVersion: z.enum(["v1", "v2"]).optional(),
      })
      .strict()
      .default({
        clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
        tenant: "common",
      }),
    google: z
      .object({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
      .strict()
      .optional(),
    autoAuth: z
      .array(z.object({ account, totpSecret: z.string().min(1).optional() }).strict())
      .optional(),
    roles: z.array(roleSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const roleIds = new Set<string>();
    for (const [roleIndex, role] of config.roles.entries()) {
      if (roleIds.has(role.id))
        ctx.addIssue({
          code: "custom",
          path: ["roles", roleIndex, "id"],
          message: "duplicate role id",
        });
      roleIds.add(role.id);
      const connectorIds = new Set<string>();
      for (const kind of CONNECTOR_KINDS) {
        for (const [connectorIndex, connector] of (role.connectors[kind] ?? []).entries()) {
          if (connectorIds.has(connector.id))
            ctx.addIssue({
              code: "custom",
              path: ["roles", roleIndex, "connectors", kind, connectorIndex, "id"],
              message: "connector id must be unique within a role",
            });
          connectorIds.add(connector.id);
        }
      }
    }
  });

export function parseAppConfig(raw: unknown): AppConfig {
  const result = appConfigSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  return result.data;
}
