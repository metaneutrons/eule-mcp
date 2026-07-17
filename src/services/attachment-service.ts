import { mkdirSync, writeFileSync } from "node:fs";
import type { MailService } from "./mail-service.js";
import { extractAttachmentText } from "../utils/attachment-extract.js";
import { securePath } from "../utils/path-sandbox.js";

const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type AttachmentResult =
  | { readonly kind: "image"; readonly data: string; readonly mimeType: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "saved"; readonly dest: string; readonly size: number };

export class AttachmentService {
  constructor(private readonly mail: MailService) {}
  async get(input: {
    messageId: string;
    attachmentId: string;
    account: string;
    role?: string;
    name: string;
    mode: "save" | "text" | "inline";
    path?: string;
  }): Promise<AttachmentResult> {
    const connector = this.mail.getConnector(input.account, input.role);
    const data = await connector.downloadAttachment(input.messageId, input.attachmentId);
    if (input.mode === "inline") {
      const mimeType = IMAGE_MIME[input.name.slice(input.name.lastIndexOf(".") + 1).toLowerCase()];
      if (!mimeType) throw new Error(`${input.name} is not a supported image`);
      if (data.length > MAX_INLINE_BYTES) throw new Error(`${input.name} is too large to inline`);
      return { kind: "image", data: data.toString("base64"), mimeType };
    }
    if (input.mode === "text") {
      const extracted = extractAttachmentText(data, input.name);
      const text =
        extracted.text.length > MAX_TEXT_CHARS
          ? `${extracted.text.slice(0, MAX_TEXT_CHARS)}\n\n…[truncated]`
          : extracted.text;
      return {
        kind: "text",
        text: `📄 ${input.name} (extracted via ${extracted.method})\n\n${text}`,
      };
    }
    const { dir, dest } = securePath(
      input.path,
      input.name,
      `attachments/${input.messageId.slice(0, 32)}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, data);
    return { kind: "saved", dest, size: data.length };
  }
}
