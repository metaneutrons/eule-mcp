/** Text of a parsed XML value, which fast-xml-parser may hand over as a string, number or node. */
function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>))
    return String((value as Record<string, unknown>)["#text"]);
  return JSON.stringify(value);
}

/**
 * EWS reports a failed operation with HTTP 200 and a response message whose
 * ResponseClass is "Error". Find the first such message anywhere in the reply.
 */
export function ewsFailure(node: unknown): { code: string; message: string } | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = ewsFailure(entry);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (record["@_ResponseClass"] === "Error")
    return {
      code: text(record.ResponseCode) || "Error",
      message: text(record.MessageText) || "request failed",
    };
  for (const value of Object.values(record)) {
    const found = ewsFailure(value);
    if (found) return found;
  }
  return undefined;
}
