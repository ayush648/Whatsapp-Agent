import { PDFParse } from "pdf-parse";

const MAX_CHARS = 8000;

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = (result.text || "").trim();
    if (text.length <= MAX_CHARS) return text;
    return text.slice(0, MAX_CHARS) + "\n\n[truncated]";
  } finally {
    await parser.destroy();
  }
}
