import zlib from "node:zlib";

/**
 * Extracts the text actually drawn into a pdf-lib PDF.
 *
 * pdf-lib writes strings as hex inside the content stream (`<48656C6C6F> Tj`),
 * and Flate-compresses the stream, so we inflate then decode. This lets the
 * tests assert what a customer reads on the document rather than trusting the
 * code that produced it.
 */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const words: string[] = [];

  const streamRe = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;

    const chunk = Buffer.from(raw.slice(start, end), "latin1");
    let body: string;
    try {
      body = zlib.inflateSync(chunk).toString("latin1");
    } catch {
      body = chunk.toString("latin1");
    }

    for (const hit of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hex = hit[1];
      let word = "";
      for (let i = 0; i + 1 < hex.length; i += 2) {
        word += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
      }
      words.push(word);
    }
  }

  return words.join("\n");
}
