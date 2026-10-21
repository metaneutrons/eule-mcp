/**
 * Built-in text extraction that needs nothing outside the Node runtime, so it
 * also works inside the Claude Desktop extension bundle: PDFs through unpdf
 * (pdf.js), DOCX by reading the WordprocessingML out of the ZIP container.
 */
import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/** Raised when a document holds no extractable text (e.g. a scanned PDF). */
export class NoTextError extends Error {}

/** Text of every page, separated by a page marker. */
export async function pdfToText(data: Uint8Array): Promise<string> {
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    pages = (await extractText(pdf, { mergePages: false })).text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The PDF could not be read (${reason}).`, { cause: error });
  }
  if (!pages.some((page) => page.trim()))
    throw new NoTextError("The PDF has no text layer (probably a scan).");
  if (pages.length === 1) return pages[0]?.trim() ?? "";
  return pages
    .map((page, index) => `--- Page ${String(index + 1)} ---\n\n${page.trim()}`)
    .join("\n\n");
}

/** One node of fast-xml-parser's preserveOrder output. */
type OrderedNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  processEntities: true,
});

function tagOf(node: OrderedNode): string | undefined {
  return Object.keys(node).find((key) => key !== ":@");
}

function children(node: OrderedNode): OrderedNode[] {
  const tag = tagOf(node);
  const value = tag ? node[tag] : undefined;
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function find(nodes: OrderedNode[], tag: string): OrderedNode | undefined {
  return nodes.find((node) => tagOf(node) === tag);
}

/** Plain text of a run tree: text, tabs and line breaks. */
function runText(nodes: OrderedNode[]): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "#text") out += String(node["#text"]);
    else if (tag === "w:tab") out += "\t";
    else if (tag === "w:br" || tag === "w:cr") out += "\n";
    else if (tag === "w:delText" || tag === "w:instrText") continue;
    else out += runText(children(node));
  }
  return out;
}

function paragraph(node: OrderedNode): string {
  const parts = children(node);
  const props = children(find(parts, "w:pPr") ?? {});
  const style = find(props, "w:pStyle")?.[":@"]?.["w:val"] ?? "";
  const text = runText(parts.filter((part) => tagOf(part) !== "w:pPr")).trim();
  if (!text) return "";
  // Built-in heading styles are "Heading1" … "Heading9" (localized names map to these ids).
  const heading = /^heading(\d)$/i.exec(style);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;
  if (/^title$/i.test(style)) return `# ${text}`;
  if (find(props, "w:numPr")) return `- ${text}`;
  return text;
}

function table(node: OrderedNode): string {
  return children(node)
    .filter((row) => tagOf(row) === "w:tr")
    .map((row) =>
      children(row)
        .filter((cell) => tagOf(cell) === "w:tc")
        .map((cell) =>
          children(cell)
            .filter((part) => tagOf(part) === "w:p")
            .map(paragraph)
            .filter(Boolean)
            .join(" "),
        )
        .join(" | "),
    )
    .join("\n");
}

function blocks(nodes: OrderedNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:p") out.push(paragraph(node));
    else if (tag === "w:tbl") out.push(table(node));
    else if (tag === "w:sdt" || tag === "w:sdtContent") out.push(...blocks(children(node)));
  }
  return out.filter(Boolean);
}

/** Readable text of a DOCX file: headings, list items, paragraphs, tables. */
export function docxToText(data: Uint8Array): string {
  let xml: string;
  try {
    const entry = unzipSync(new Uint8Array(data), {
      filter: (file) => file.name === "word/document.xml",
    })["word/document.xml"];
    if (!entry) throw new Error("word/document.xml is missing");
    xml = strFromU8(entry);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The DOCX file could not be read (${reason}).`, { cause: error });
  }
  const tree = parser.parse(xml) as OrderedNode[];
  const document = find(tree, "w:document");
  const body = find(children(document ?? {}), "w:body");
  const text = blocks(children(body ?? {})).join("\n\n");
  if (!text.trim()) throw new NoTextError("The DOCX file contains no text.");
  return text;
}
