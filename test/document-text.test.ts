import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { extractAttachmentText } from "../src/utils/attachment-extract.js";
import { docxToText, NoTextError, pdfToText } from "../src/utils/document-text.js";

/** A minimal, valid PDF whose pages show the given lines in Helvetica. */
function pdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const pageId = pageIds[index] ?? 0;
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageId + 1)} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${String(id)} 0 obj\n${objects[id] ?? ""}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1)
    out += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return strToU8(out);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ),
  });
}

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("pdfToText", () => {
  it("reads the text of a single page", async () => {
    expect(await pdfToText(pdf(["Rechnung 26-0003"]))).toBe("Rechnung 26-0003");
  });

  it("marks page boundaries", async () => {
    const text = await pdfToText(pdf(["Erste Seite", "Zweite Seite"]));
    expect(text).toBe("--- Page 1 ---\n\nErste Seite\n\n--- Page 2 ---\n\nZweite Seite");
  });

  it("reports a PDF without a text layer", async () => {
    await expect(pdfToText(pdf([""]))).rejects.toBeInstanceOf(NoTextError);
  });

  it("reports a damaged PDF readably", async () => {
    await expect(pdfToText(strToU8("not a pdf"))).rejects.toThrow(/could not be read/);
  });
});

describe("docxToText", () => {
  it("keeps headings, list items, paragraphs and tables", () => {
    // A fixed WordprocessingML body: heading, paragraph runs, list item, table, break and tab.
    const body =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Angebot</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Sehr geehrte </w:t></w:r><w:r><w:t xml:space="preserve">Damen &amp; Herren,</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Punkt eins</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Pos.</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">Betrag</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">500,00 €</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t xml:space="preserve">Zeile</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">Umbruch</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">Tab</w:t></w:r></w:p>';
    expect(docxToText(docx(body))).toBe(
      [
        "# Angebot",
        "Sehr geehrte Damen & Herren,",
        "- Punkt eins",
        "Pos. | Betrag\n1 | 500,00 €",
        "Zeile\nUmbruch\tTab",
      ].join("\n\n"),
    );
  });

  it("rejects a file that is not a DOCX archive", () => {
    expect(() => docxToText(strToU8("plain text"))).toThrow(/could not be read/);
  });
});

describe("extractAttachmentText", () => {
  it("extracts PDFs without any external program", async () => {
    const result = await extractAttachmentText(Buffer.from(pdf(["Beleg"])), "beleg.pdf");
    expect(result).toEqual({ text: "Beleg", method: "unpdf" });
  });

  it("falls back to the built-in DOCX reader when pandoc is missing", async () => {
    const fileCache = await import("../src/utils/file-cache.js");
    vi.spyOn(fileCache, "hasPandoc").mockReturnValue(false);
    const result = await extractAttachmentText(
      Buffer.from(docx(`<w:p>${run("Hallo")}</w:p>`)),
      "brief.docx",
    );
    expect(result).toEqual({ text: "Hallo", method: "docx" });
    vi.restoreAllMocks();
  });

  it("explains a scanned PDF instead of failing with a traceback", async () => {
    await expect(extractAttachmentText(Buffer.from(pdf([""])), "scan.pdf")).rejects.toThrow(
      /scan\.pdf: .*no text layer.*mode "save"/,
    );
  });
});
