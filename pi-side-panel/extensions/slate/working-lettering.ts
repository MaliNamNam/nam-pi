/**
 * Classic Adafruit GFX 5x7 font, packed into fine 2x4-dot Braille cells.
 * Source: https://github.com/adafruit/Adafruit-GFX-Library/blob/master/glcdfont.c
 * Eight bitmap rows retain the lowercase descenders, including the g in -ing.
 *
 * Software License Agreement (BSD License)
 * Copyright (c) 2012 Adafruit Industries. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
const GLYPHS: Record<string, readonly number[]> = {
  A: [0x7c, 0x12, 0x11, 0x12, 0x7c],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x41, 0x3e],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x41, 0x51, 0x73],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x1c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x26, 0x49, 0x49, 0x49, 0x32],
  T: [0x03, 0x01, 0x7f, 0x01, 0x03],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x03, 0x04, 0x78, 0x04, 0x03],
  Z: [0x61, 0x59, 0x49, 0x4d, 0x43],
  a: [0x20, 0x54, 0x54, 0x78, 0x40],
  b: [0x7f, 0x28, 0x44, 0x44, 0x38],
  c: [0x38, 0x44, 0x44, 0x44, 0x28],
  d: [0x38, 0x44, 0x44, 0x28, 0x7f],
  e: [0x38, 0x54, 0x54, 0x54, 0x18],
  f: [0x00, 0x08, 0x7e, 0x09, 0x02],
  g: [0x18, 0xa4, 0xa4, 0x9c, 0x78],
  h: [0x7f, 0x08, 0x04, 0x04, 0x78],
  i: [0x00, 0x44, 0x7d, 0x40, 0x00],
  j: [0x20, 0x40, 0x40, 0x3d, 0x00],
  k: [0x7f, 0x10, 0x28, 0x44, 0x00],
  l: [0x00, 0x41, 0x7f, 0x40, 0x00],
  m: [0x7c, 0x04, 0x78, 0x04, 0x78],
  n: [0x7c, 0x08, 0x04, 0x04, 0x78],
  o: [0x38, 0x44, 0x44, 0x44, 0x38],
  p: [0xfc, 0x18, 0x24, 0x24, 0x18],
  q: [0x18, 0x24, 0x24, 0x18, 0xfc],
  r: [0x7c, 0x08, 0x04, 0x04, 0x08],
  s: [0x48, 0x54, 0x54, 0x54, 0x24],
  t: [0x04, 0x04, 0x3f, 0x44, 0x24],
  u: [0x3c, 0x40, 0x40, 0x20, 0x7c],
  v: [0x1c, 0x20, 0x40, 0x20, 0x1c],
  w: [0x3c, 0x40, 0x30, 0x40, 0x3c],
  x: [0x44, 0x28, 0x10, 0x28, 0x44],
  y: [0x4c, 0x90, 0x90, 0x90, 0x7c],
  z: [0x44, 0x64, 0x54, 0x4c, 0x44],
};

const DOT_BITS = [[0, 1, 2, 6], [3, 4, 5, 7]] as const;

/** Trim empty edge columns only; narrow i/l stay proportional. */
function trimmedGlyph(char: string): number[] {
  const glyph = [...GLYPHS[char]!];
  while (glyph[0] === 0) glyph.shift();
  while (glyph.at(-1) === 0) glyph.pop();
  return glyph;
}

/**
 * Widen the strokes, not the terminal glyphs. Work letter by letter so
 * dilation never closes the gap to the neighbour.
 */
function strokedGlyph(glyph: number[], strokeWidth: 1 | 2): number[] {
  if (strokeWidth === 1) return glyph;
  return Array.from({ length: glyph.length + 1 }, (_, col) => (glyph[col] ?? 0) | (glyph[col - 1] ?? 0));
}

/** The label's dot columns at native letter widths, single blank gaps included. */
function nativeColumns(label: string, strokeWidth: 1 | 2): number[] {
  const columns: number[] = [];
  for (const char of label) {
    if (columns.length > 0) columns.push(0);
    columns.push(...strokedGlyph(trimmedGlyph(char), strokeWidth));
  }
  return columns;
}

/** Pack dot columns into Braille cells, centred vertically in `rows` text rows. */
function brailleLines(columns: number[], rows: number): string[] {
  const pixelWidth = columns.length;
  const sourceHeight = 8;
  const textCols = Math.ceil(pixelWidth / 2);
  const top = Math.floor((rows * 4 - sourceHeight) / 2);
  const pixel = (x: number, y: number): boolean => {
    if (x >= pixelWidth || y < top || y >= top + sourceHeight) return false;
    return (columns[x]! & (1 << (y - top))) !== 0;
  };
  return Array.from({ length: rows }, (_, row) => {
    let line = "";
    for (let col = 0; col < textCols; col++) {
      let bits = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          if (pixel(col * 2 + dx, row * 4 + dy)) bits |= 1 << DOT_BITS[dx]![dy]!;
        }
      }
      line += bits ? String.fromCodePoint(0x2800 + bits) : " ";
    }
    return line;
  });
}

/**
 * Fit intact lettering with uniform scaling, never stretching it horizontally.
 * A two-dot stroke adds a neighbouring column within each letter, preserving
 * its height, descenders, and the gaps between letters. The caller centres the
 * returned lines. Labels too wide for native-size dots return undefined so the
 * caller can try a thinner stroke or `fitCondensedLettering`.
 */
export function fitWorkingLettering(
  label: string,
  cols: number,
  rows: number,
  strokeWidth: 1 | 2 = 1,
): string[] | undefined {
  if (rows < 2 || cols < 1 || !/^[A-Za-z]+$/.test(label)) return undefined;
  const columns = nativeColumns(label, strokeWidth);
  const sourceWidth = columns.length;
  const sourceHeight = 8;
  const scale = Math.min(cols * 2 / sourceWidth, rows * 4 / sourceHeight);
  if (scale < 1) return undefined; // Do not erase dots or inter-letter gaps.

  const pixelWidth = Math.floor(sourceWidth * scale);
  const pixelHeight = Math.floor(sourceHeight * scale);
  const top = Math.floor((rows * 4 - pixelHeight) / 2);
  const pixel = (x: number, y: number): boolean => {
    if (x >= pixelWidth || y < top || y >= top + pixelHeight) return false;
    const sourceX = Math.floor(x * sourceWidth / pixelWidth);
    const sourceY = Math.floor((y - top) * sourceHeight / pixelHeight);
    return (columns[sourceX]! & (1 << sourceY)) !== 0;
  };

  return Array.from({ length: rows }, (_, row) => {
    let line = "";
    for (let col = 0; col < Math.ceil(pixelWidth / 2); col++) {
      let bits = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          if (pixel(col * 2 + dx, row * 4 + dy)) bits |= 1 << DOT_BITS[dx]![dy]!;
        }
      }
      line += bits ? String.fromCodePoint(0x2800 + bits) : " ";
    }
    return line;
  });
}

/**
 * Condensed dot lettering for words too wide for native-size dots.
 *
 * Dot columns merge letter by letter — never the blank column between letters —
 * so a long verb keeps the dotted font at the panel's narrow default width
 * instead of falling back to plain text. Letters keep their relative widths,
 * and every letter keeps at least two dot columns: a single column of dots is
 * a smear, not a letter. A label that cannot give every letter two columns, or
 * an unsupported label, returns undefined so the caller can fall back.
 */
export function fitCondensedLettering(label: string, cols: number, rows: number): string[] | undefined {
  if (rows < 2 || cols < 1 || !/^[A-Za-z]+$/.test(label)) return undefined;
  const glyphs = [...label].map((char) => trimmedGlyph(char));
  const gaps = glyphs.length - 1;
  const available = cols * 2 - gaps;
  if (available < glyphs.length * 2) return undefined;

  // Give every letter a share of the available dot columns, then hand the
  // rounding leftovers to the letters that were cut the most.
  const sourceTotal = glyphs.reduce((sum, glyph) => sum + glyph.length, 0);
  const widths = glyphs.map((glyph) => glyph.length * available / sourceTotal);
  const target = widths.map((width) => Math.max(2, Math.floor(width)));
  let leftover = available - target.reduce((sum, width) => sum + width, 0);
  const order = widths
    .map((width, index) => ({ index, fraction: width - Math.floor(width) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; leftover > 0; i++, leftover--) target[order[i % order.length]!.index]! += 1;
  // Flooring cannot overshoot, but keep the guard so no label can ever render
  // wider than the box if the widths are ever retuned.
  for (let i = 0; leftover < 0; i++) {
    const widest = target.reduce((best, width, index) => width > target[best]! ? index : best, 0);
    if (target[widest]! <= 2) break;
    target[widest]! -= 1;
    leftover += 1;
  }

  // Merge each letter's dot columns on its own, so no letter ever eats into
  // its neighbour or the gap between them.
  const columns: number[] = [];
  glyphs.forEach((glyph, index) => {
    if (index > 0) columns.push(0);
    const width = target[index]!;
    const merged = new Array<number>(width).fill(0);
    for (let source = 0; source < glyph.length; source++) {
      const dot = Math.min(width - 1, Math.floor(source * width / glyph.length));
      merged[dot] |= glyph[source]!;
    }
    columns.push(...merged);
  });
  return brailleLines(columns, rows);
}
