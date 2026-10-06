import zlib from "node:zlib";

/**
 * Where things actually sit on a pdf-lib page.
 *
 * pdfText answers "what does it say", which is enough for wording but says
 * nothing about a filled rectangle printing straight through a line of text -
 * the status badge shipped doing exactly that, and every text assertion passed
 * while it did, because both the badge and the date were present and correct
 * and simply drawn on top of one another.
 *
 * So this reads the positions too. pdf-lib writes each run as
 *
 *     /Font-1234 10 Tf ... 1 0 0 1 X Y Tm <hex> Tj
 *
 * and each filled box as `X Y W H re` followed by `f`, which is enough to put
 * both in the same coordinate space and ask whether they collide.
 */

export type TextBox = {
  text: string;
  /** PDF user space: x from the left edge, y from the BOTTOM edge. */
  x: number;
  y: number;
  size: number;
  /** Rough ink extent around the baseline, in points. */
  top: number;
  bottom: number;
};

export type RectBox = { x: number; y: number; width: number; height: number };

function streams(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const chunk = Buffer.from(raw.slice(start, end), "latin1");
    try {
      out.push(zlib.inflateSync(chunk).toString("latin1"));
    } catch {
      out.push(chunk.toString("latin1"));
    }
  }
  return out;
}

function fromHex(hex: string): string {
  let s = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return s;
}

/**
 * Helvetica's cap height and descender, near enough for a collision test.
 *
 * Exact metrics would need the font tables; what this is used for is "does a
 * box overlap this line", where being a point out either way changes nothing
 * and being generous errs towards reporting a collision rather than missing
 * one.
 */
const ASCENT = 0.72;
const DESCENT = 0.21;

export function pdfBoxes(bytes: Uint8Array): { texts: TextBox[]; rects: RectBox[] } {
  const texts: TextBox[] = [];
  const rects: RectBox[] = [];

  for (const body of streams(bytes)) {
    // Text: the last Tf before a Tm/Tj gives the size, the Tm gives the origin.
    const runRe =
      /\/[A-Za-z0-9+\-]+\s+([\d.]+)\s+Tf[\s\S]{0,80}?1\s+0\s+0\s+1\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\s*<([0-9A-Fa-f]+)>\s*Tj/g;
    let m: RegExpExecArray | null;
    while ((m = runRe.exec(body)) !== null) {
      const size = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      texts.push({
        text: fromHex(m[4]!),
        x,
        y,
        size,
        top: y + size * ASCENT,
        bottom: y - size * DESCENT,
      });
    }

    /**
     * pdf-lib does not emit `re` for a filled rectangle. It translates to the
     * corner and walks the path:
     *
     *     1 0 0 1 X Y cm ... 0 0 m  0 H l  W H l  W 0 l  h  f
     *
     * so the position comes from the cm and the size from the path. Finding
     * this out took dumping a real stream; guessing at `re` returned no
     * rectangles at all and would have made every collision check pass by
     * having nothing to check.
     */
    const rectRe =
      /1\s+0\s+0\s+1\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm[\s\S]{0,60}?0\s+0\s+m\s+0\s+(-?[\d.]+)\s+l\s+(-?[\d.]+)\s+-?[\d.]+\s+l\s+-?[\d.]+\s+0\s+l\s+h\s+f/g;
    let r: RegExpExecArray | null;
    while ((r = rectRe.exec(body)) !== null) {
      rects.push({
        x: Number(r[1]),
        y: Number(r[2]),
        width: Number(r[4]),
        height: Number(r[3]),
      });
    }
  }

  return { texts, rects };
}

/**
 * Does a filled box print over this line of text?
 *
 * Text wholly inside the box does not count, and that exception is the whole
 * reason this is a named function rather than a rectangle intersection. A badge
 * and a banded total both work by drawing their label on their own fill; a
 * plain intersection calls every one of those a collision and the check becomes
 * noise nobody can act on. What goes wrong is a box PARTLY across something -
 * a red badge through the top half of a date.
 */
export function overlaps(rect: RectBox, t: TextBox, textWidth: number): boolean {
  const left = t.x;
  const right = t.x + textWidth;
  const intersects =
    rect.y < t.top && rect.y + rect.height > t.bottom && rect.x < right && rect.x + rect.width > left;
  if (!intersects) return false;

  const contained =
    rect.x <= left && rect.x + rect.width >= right && rect.y <= t.bottom && rect.y + rect.height >= t.top;
  return !contained;
}
