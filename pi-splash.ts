/**
 * Pi splash: a slowly turning 3D π in white and grey as the startup header.
 *
 * Replaces pi's header area, so the spinning π is on display whenever no
 * messages are on screen yet — on startup, a new session, or a session switch —
 * and scrolls away with the conversation like the header it replaces.
 *
 * The 3D renderer is adapted from mavam/pi-splash (MIT), which adapted it from
 * Pi's 1.0 logo Easter egg — reduced here to one symbol (the mathematical π),
 * one color scheme (white/grey), and no settings.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Art ─────────────────────────────────────────────────────────────────────

/** The digits of π, laid out as the π. */
const PI_ART = [
  "    3.141592653589793238462643383279",
  "   5028841971693993751058209749445923",
  "  07816406286208998628034825342117067",
  "  9821    48086         5132",
  " 823      06647        09384",
  "46        09550        58223",
  "          1725         3594",
  "         08128        48111",
  "        74502         84102",
  "       70193          85211        05",
  "     5596446           22948954930381",
  "    9644288             10975665933",
];

// ── Color ───────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

interface Palette {
  at(column: number, row: number): Rgb;
}

/** Lightness of the unshaded art; the 3D faces are shaded relative to it. */
const BASE_LIGHTNESS = 0.65;

function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rf) h = ((gf - bf) / d) % 6;
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** Scale the lightness of a color; used to light the faces of the 3D slab. */
function shade(color: Rgb, factor: number): Rgb {
  const [h, s, l] = rgbToHsl(color);
  return hslToRgb(h, s, Math.min(0.92, l * factor));
}

/** Where a cell sits along the art's diagonal, from 0 to 1. */
const DIAGONAL_SPAN = Math.max(
  ...PI_ART.flatMap((line, row) =>
    [...line].flatMap((char, column) => (char === " " ? [] : [column + row * 3])),
  ),
);

/** White fading to grey along the art's diagonal; the face shading adds the rest. */
const PALETTE: Palette = {
  at(column, row) {
    const t = Math.min(1, Math.max(0, (column + row * 3) / DIAGONAL_SPAN));
    const from: Rgb = [242, 242, 242];
    const to: Rgb = [140, 140, 140];
    return [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
  },
};

// ── 3D renderer (adapted from pi-splash's pi3d.ts) ──────────────────────────

/**
 * A 3D π: the ASCII art extruded into a slab and ray-cast into Unicode braille
 * cells (2x4 dots each). Every non-space character of the art becomes a filled
 * cell of a 2D mask; the slab is a prism over that mask, so a ray through it can
 * be traced with a 2D grid walk between the slab's front and back planes.
 */

interface Pose {
  yaw: number;
  pitch: number;
}

const DEFAULT_POSE: Pose = { yaw: -0.35, pitch: 0.2 };
const DEFAULT_THICKNESS = 8;
const DEFAULT_SIZE = 1;

/** Rows above and below the art. */
const MARGIN_ROWS = 1;
const CELL_WIDTH = 2;
const CELL_HEIGHT = 4;
const CAMERA_DISTANCE = 400;
/** Extra columns on each side of the art for the rotated slab to reach into. */
const MARGIN_COLUMNS = 8;
/** The fewest rows to draw in, however small the terminal. */
const MIN_LINES = 5;
/** Keeps the scale positive when the canvas is almost empty. */
const MIN_SCALE = 0.05;
const LIGHT = normalize([-0.45, -0.6, 0.66]);
const RESET = "\x1b[0m";
/** Axis and sign of the six faces: -x, +x, -y, +y, -z, +z. */
const FACES: [number, number][] = [[0, -1], [0, 1], [1, -1], [1, 1], [2, -1], [2, 1]];
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];

const COLUMNS = Math.max(...PI_ART.map((line) => line.length));
const ROWS = PI_ART.length;
const HALF_WIDTH = (COLUMNS * CELL_WIDTH) / 2;
const HALF_HEIGHT = (ROWS * CELL_HEIGHT) / 2;
const FILLED = PI_ART.map((line) =>
  Array.from({ length: COLUMNS }, (_, column) => (line[column] ?? " ") !== " "),
);

type Vec3 = [number, number, number];
type Matrix = [number, number, number, number, number, number, number, number, number];

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / length, v[1]! / length, v[2]! / length];
}

/** Row-major matrix taking object space to camera space: pitch after yaw. */
function rotation({ yaw, pitch }: Pose): Matrix {
  const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
}

interface Hit {
  column: number;
  row: number;
  /** Axis of the face that was hit: 0 = x, 1 = y, 2 = z. */
  axis: number;
  /** Which way the face points along that axis. */
  sign: number;
}

/** Trace a ray through the slab; the nearest filled cell and face, if any. */
function trace(origin: Vec3, direction: Vec3, halfDepth: number): Hit | undefined {
  const half: Vec3 = [HALF_WIDTH, HALF_HEIGHT, halfDepth];
  let enter = 0;
  let exit = Infinity;
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    const o = origin[a]!;
    const d = direction[a]!;
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > half[a]!) return undefined;
      continue;
    }
    let t0 = (-half[a]! - o) / d;
    let t1 = (half[a]! - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > enter) {
      enter = t0;
      axis = a;
    }
    exit = Math.min(exit, t1);
  }
  if (axis < 0 || enter > exit) return undefined;

  const x = origin[0]! + enter * direction[0]!;
  const y = origin[1]! + enter * direction[1]!;
  let column = Math.min(COLUMNS - 1, Math.max(0, Math.floor((x + HALF_WIDTH) / CELL_WIDTH)));
  let row = Math.min(ROWS - 1, Math.max(0, Math.floor((y + HALF_HEIGHT) / CELL_HEIGHT)));
  const stepX = Math.sign(direction[0]!);
  const stepY = Math.sign(direction[1]!);
  const next = (o: number, d: number, index: number, size: number, half: number, step: number) =>
    step === 0 ? Infinity : ((step > 0 ? index + 1 : index) * size - half - o) / d;
  let nextX = next(origin[0]!, direction[0]!, column, CELL_WIDTH, HALF_WIDTH, stepX);
  let nextY = next(origin[1]!, direction[1]!, row, CELL_HEIGHT, HALF_HEIGHT, stepY);
  const deltaX = stepX === 0 ? Infinity : CELL_WIDTH / Math.abs(direction[0]!);
  const deltaY = stepY === 0 ? Infinity : CELL_HEIGHT / Math.abs(direction[1]!);

  let normalAxis = axis;
  let sign = -Math.sign(direction[axis]!);
  for (;;) {
    if (FILLED[row]![column]) return { column, row, axis: normalAxis, sign };
    if (nextX < nextY) {
      if (nextX > exit) return undefined;
      column += stepX;
      nextX += deltaX;
      normalAxis = 0;
      sign = -stepX;
    } else {
      if (nextY > exit) return undefined;
      row += stepY;
      nextY += deltaY;
      normalAxis = 1;
      sign = -stepY;
    }
    if (column < 0 || column >= COLUMNS || row < 0 || row >= ROWS) return undefined;
  }
}

/**
 * The largest scale, up to `cap`, at which the slab stays within `halfRows` and
 * `halfColumns` dots of the canvas center for every yaw at the given pitch,
 * found by projecting its corners.
 */
const fits = new Map<string, number>();
function fitScale(depth: number, pitch: number, halfRows: number, halfColumns: number, cap: number): number {
  const key = `${depth}|${pitch}|${halfRows}|${halfColumns}|${cap}`;
  const known = fits.get(key);
  if (known !== undefined) return known;

  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  let reachX = 0;
  let reachY = 0;
  for (let step = 0; step < 180; step++) {
    const [cy, sy] = [Math.cos((step / 180) * Math.PI * 2), Math.sin((step / 180) * Math.PI * 2)];
    for (const x of [-HALF_WIDTH, HALF_WIDTH]) {
      for (const y of [-HALF_HEIGHT, HALF_HEIGHT]) {
        for (const z of [-depth / 2, depth / 2]) {
          const xc = cy * x + sy * z;
          const yc = sp * sy * x + cp * y - sp * cy * z;
          const zc = -cp * sy * x + sp * y + cp * cy * z;
          const factor = CAMERA_DISTANCE / (CAMERA_DISTANCE - zc);
          reachX = Math.max(reachX, Math.abs(xc * factor));
          reachY = Math.max(reachY, Math.abs(yc * factor));
        }
      }
    }
  }
  // Two dots of breathing room.
  const scale = Math.max(MIN_SCALE, Math.min(cap, (halfRows - 2) / reachY, (halfColumns - 2) / reachX));
  fits.set(key, scale);
  return scale;
}

/** The splash screen's rows: blank, the art, blank; each a braille line with 24-bit color. */
function render3dLines(
  width: number,
  options: { pose?: Pose; maxRows?: number } = {},
): string[] {
  const { pose = DEFAULT_POSE, maxRows = 0 } = options;
  const thickness = DEFAULT_THICKNESS;
  const size = DEFAULT_SIZE;
  const depth = thickness * CELL_WIDTH;

  // The canvas is the default one scaled by the size, as far as the terminal allows.
  const defaultLines = ROWS + MARGIN_ROWS * 2;
  const wantedLines = Math.max(MIN_LINES, Math.round(defaultLines * size));
  const lines = maxRows > 0 ? Math.max(MIN_LINES, Math.min(wantedLines, maxRows)) : wantedLines;
  const grown = lines / defaultLines;
  const artCenter = Math.floor((width - COLUMNS) / 2) + COLUMNS / 2;
  const wantedCells = Math.round((COLUMNS + MARGIN_COLUMNS * 2) * grown);
  const left = Math.max(0, Math.min(Math.round(artCenter - wantedCells / 2), width - wantedCells));
  const right = Math.min(width, left + wantedCells);
  const cells = Math.max(0, right - left);
  const dotWidth = cells * CELL_WIDTH;
  const dotHeight = lines * CELL_HEIGHT;
  if (cells === 0) return Array.from({ length: lines }, () => "");

  // The art's center on the dot canvas.
  const centerX = (artCenter - left) * CELL_WIDTH;
  const centerY = dotHeight / 2;
  const scale = fitScale(depth, pose.pitch, dotHeight / 2, Math.min(centerX, dotWidth - centerX), grown);

  const m = rotation(pose);
  const halfDepth = depth / 2;
  // Camera space to object space is the transpose of the rotation.
  const toObject = (x: number, y: number, z: number): Vec3 => [
    m[0]! * x + m[3]! * y + m[6]! * z,
    m[1]! * x + m[4]! * y + m[7]! * z,
    m[2]! * x + m[5]! * y + m[8]! * z,
  ];
  const origin = toObject(0, 0, CAMERA_DISTANCE);

  // Only dots inside the projected slab can hit it.
  let minX = dotWidth;
  let minY = dotHeight;
  let maxX = -1;
  let maxY = -1;
  for (const cx of [-HALF_WIDTH, HALF_WIDTH]) {
    for (const cy of [-HALF_HEIGHT, HALF_HEIGHT]) {
      for (const cz of [-halfDepth, halfDepth]) {
        const x = m[0]! * cx + m[1]! * cy + m[2]! * cz;
        const y = m[3]! * cx + m[4]! * cy + m[5]! * cz;
        const z = m[6]! * cx + m[7]! * cy + m[8]! * cz;
        const factor = (scale * CAMERA_DISTANCE) / (CAMERA_DISTANCE - z);
        minX = Math.min(minX, Math.floor(centerX + x * factor));
        maxX = Math.max(maxX, Math.ceil(centerX + x * factor));
        minY = Math.min(minY, Math.floor(centerY + y * factor));
        maxY = Math.max(maxY, Math.ceil(centerY + y * factor));
      }
    }
  }
  minX = Math.max(0, minX - 1);
  minY = Math.max(0, minY - 1);
  maxX = Math.min(dotWidth - 1, maxX + 1);
  maxY = Math.min(dotHeight - 1, maxY + 1);

  const regionWidth = maxX - minX + 1;
  const regionHeight = maxY - minY + 1;
  /** The color of every dot that hit the slab, row by row within the region. */
  const dotColors: (Rgb | undefined)[] = new Array(regionWidth * regionHeight);
  const bits = new Uint8Array(cells * lines);
  const counts = new Uint8Array(cells * lines);
  const rgb = new Float32Array(cells * lines * 3);
  // Faces are shaded by lightness, so darker sides keep their hue.
  const lightness = FACES.map(([axis, sign]) => {
    const nx = m[axis]! * sign;
    const ny = m[3 + axis]! * sign;
    const nz = m[6 + axis]! * sign;
    return 0.4 + 0.4 * Math.max(0, nx * LIGHT[0]! + ny * LIGHT[1]! + nz * LIGHT[2]!);
  });
  const colors = new Map<number, Rgb>();

  for (let dotY = minY; dotY <= maxY; dotY++) {
    for (let dotX = minX; dotX <= maxX; dotX++) {
      const direction = toObject(
        (dotX + 0.5 - centerX) / scale,
        (dotY + 0.5 - centerY) / scale,
        -CAMERA_DISTANCE,
      );
      const hit = trace(origin, direction, halfDepth);
      if (!hit) continue;

      const face = hit.axis * 2 + (hit.sign > 0 ? 1 : 0);
      const key = (hit.row * COLUMNS + hit.column) * FACES.length + face;
      let color = colors.get(key);
      if (!color) {
        color = shade(PALETTE.at(hit.column, hit.row), lightness[face]! / BASE_LIGHTNESS);
        colors.set(key, color);
      }

      dotColors[(dotY - minY) * regionWidth + (dotX - minX)] = color;
    }
  }

  // Dots that hang off the shape by a single neighbor are slivers of faces seen
  // edge-on. They read as stray specks, so they are dropped.
  for (let dotY = minY; dotY <= maxY; dotY++) {
    for (let dotX = minX; dotX <= maxX; dotX++) {
      const index = (dotY - minY) * regionWidth + (dotX - minX);
      const color = dotColors[index];
      if (!color) continue;
      const neighbors =
        (dotX > minX && dotColors[index - 1] ? 1 : 0) +
        (dotX < maxX && dotColors[index + 1] ? 1 : 0) +
        (dotY > minY && dotColors[index - regionWidth] ? 1 : 0) +
        (dotY < maxY && dotColors[index + regionWidth] ? 1 : 0);
      if (neighbors < 2) continue;

      const cell = (dotY >> 2) * cells + (dotX >> 1);
      bits[cell]! |= DOT_BITS[(dotY & 3) * 2 + (dotX & 1)]!;
      counts[cell]!++;
      rgb[cell * 3]! += color[0];
      rgb[cell * 3 + 1]! += color[1];
      rgb[cell * 3 + 2]! += color[2];
    }
  }

  const out: string[] = [];
  for (let row = 0; row < lines; row++) {
    let line = "";
    let blanks = 0;
    let color = "";
    for (let column = 0; column < cells; column++) {
      const cell = row * cells + column;
      if (bits[cell] === 0) {
        blanks++;
        continue;
      }
      if (line === "") blanks += left;
      line += " ".repeat(blanks);
      blanks = 0;
      const n = counts[cell]!;
      const next = `\x1b[38;2;${Math.round(rgb[cell * 3]! / n)};${Math.round(rgb[cell * 3 + 1]! / n)};${Math.round(rgb[cell * 3 + 2]! / n)}m`;
      if (next !== color) {
        line += next;
        color = next;
      }
      line += String.fromCharCode(0x2800 + bits[cell]!);
    }
    out.push(line === "" ? "" : line + RESET);
  }
  return out;
}

// ── Spinning header ─────────────────────────────────────────────────────────

const TURN = Math.PI * 2;
/** Frame interval while the π spins. */
const FRAME_MS = 50;
/** Turns per minute. */
const SPEED = 10;
/** Rows that the editor and footer keep at the bottom of the fullscreen layout. */
const DOCK_ROWS = 6;

/** Draws the splash screen and keeps the 3D slab turning. */
class SplashHeader {
  private angle = 0;
  private last = performance.now();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly requestRender: () => void,
    private readonly viewportRows: () => number,
  ) {
    this.timer = setInterval(() => requestRender(), FRAME_MS);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    const now = performance.now();
    const turns = ((now - this.last) / 60_000) * SPEED;
    this.angle = (this.angle + turns * TURN) % TURN;
    this.last = now;

    const rows = this.viewportRows();
    const lines = render3dLines(width, {
      pose: { yaw: DEFAULT_POSE.yaw + this.angle, pitch: DEFAULT_POSE.pitch },
      maxRows: rows,
    });
    // Center the π in the fullscreen viewport; regular mode leaves the layout
    // to the terminal's scrollback, where padding would only waste rows.
    const padding = rows > 0 ? Math.max(0, Math.floor((rows - lines.length) / 2)) : 0;
    return [...Array.from({ length: padding }, () => ""), ...lines];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader((tui) => {
      // Fullscreen mode has a fixed viewport to center in.
      const viewportRows = () => (tui.mode === "fullscreen" ? tui.terminal.rows - DOCK_ROWS : 0);
      const own = new SplashHeader(() => tui.requestRender(), viewportRows);
      return {
        render: (width: number) => own.render(width),
        invalidate: () => own.invalidate(),
        dispose: () => own.dispose(),
      };
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader(undefined);
  });
}
