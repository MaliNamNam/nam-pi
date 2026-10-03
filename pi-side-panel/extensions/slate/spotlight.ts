/**
 * The panel's status indicator: a monochrome spotlight sweeping a verb.
 *
 * Two effects, one file. The spotlight serves the verb lettering — the working
 * vocabulary while a turn is in flight, the idle vocabulary once it settles —
 * so the box is never blank. The border light is a single bright cell riding
 * the box's frame clockwise, drawn only while a turn is in flight; a settled
 * panel goes still.
 *
 * Adapted from terminaltexteffects' Spotlights effect. Beams search the line,
 * converge on its centre, then expand until the whole line is lit; the cycle
 * then repeats with the next verb. The original paints a colour gradient, but
 * the ramp here is built from the theme's own greys, so the effect stays inside
 * the panel's black/white palette and stays legible on either background.
 *
 * Fine dot-matrix lettering preserves the label's casing and aspect ratio.
 * Beams sweep the word rather than its surrounding space. Each label is fitted
 * independently, preferring heavier strokes, then thinner ones, then condensed
 * dots, with the original terminal text as a safe narrow-box fallback.
 *
 * The effect owns its frame counter and beam state. The sidebar decides when to
 * advance it (a timer, armed while the box has something to say) and where to
 * draw it, so nothing here touches the TUI.
 */

import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitCondensedLettering, fitWorkingLettering } from "./working-lettering.ts";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cells = (text: string): string[] => [...GRAPHEMES.segment(text)].map(({ segment }) => segment);

/**
 * The vocabulary the box cycles through while a turn is in flight, in order.
 *
 * Claude Code-style gerunds: a mix of the plain ("Working") and the absurd
 * ("Hornswoggling"), because the point of the list is to make a wait readable at
 * a glance without being dull on the hundredth turn. The renderer measures each
 * word independently rather than assuming a fixed label length.
 */
export const WORKING_VERBS = [
  "Working",
  "Discombobulating",
  "Percolating",
  "Cogitating",
  "Noodling",
  "Pondering",
  "Simmering",
  "Ruminating",
  "Synthesizing",
  "Conjuring",
  "Brewing",
  "Scheming",
  "Wrangling",
  "Mulling",
  "Tinkering",
  "Marinating",
  "Hatching",
  "Puttering",
  "Vibing",
  "Finagling",
  "Bamboozling",
  "Gallivanting",
  "Hornswoggling",
  "Kibitzing",
  "Lollygagging",
  "Meandering",
  "Nebulizing",
  "Oscillating",
  "Quibbling",
  "Sashaying",
  "Tomfoolering",
  "Unfurling",
  "Vamoosing",
  "Waddling",
  "Yammering",
  "Zigzagging",
  "Dillydallying",
  "Canoodling",
  "Flabbergasting",
  "Defenestrating",
  "Skedaddling",
  "Rambling",
  "Shimmying",
  "Spelunking",
  "Transmuting",
  "Reticulating",
  "Cerebrating",
  "Combobulating",
  "Smooshing",
  "Wibbling",
] as const;

/**
 * The vocabulary the box cycles through when no turn is in flight, in order.
 *
 * The same fine dot-matrix lettering and spotlight sweep as the working verbs:
 * an idle panel should read as alive and settled, not as a blank frame. The
 * words are deliberately restful ("Sleeping", "Idling") rather than busy, so
 * the box still tells you at a glance which state the agent is in.
 */
export const IDLE_VERBS = [
  "Idling",
  "Sleeping",
  "Resting",
  "Dozing",
  "Napping",
  "Lazing",
  "Dawdling",
  "Loitering",
  "Lingering",
  "Snoozing",
  "Slumbering",
  "Dreaming",
  "Drowsing",
  "Reposing",
  "Unwinding",
  "Hibernating",
  "Lounging",
  "Dallying",
  "Moseying",
  "Settling",
] as const;

/** Milliseconds between frames. The sweep reads as motion at roughly 16 fps. */
export const SPOTLIGHT_FRAME_MS = 60;

/** Ramp steps, dimmest first. Unlit text still renders, at the dimmest step. */
export const RAMP_LEVELS = 4;

/** Theme tokens for each ramp step; the brightest is also emboldened. */
const RAMP_TOKENS = ["dim", "muted", "text", "text"] as const;

/** How many cells of fading tail trail the travelling border light's head. */
export const BORDER_LIGHT_TAIL = 4;

export type SpotlightPhase = "search" | "converge" | "expand" | "hold";

export type SpotlightOptions = {
  /** Beam width as the label length / n. Values below 1 are raised to 1. */
  beamWidthRatio?: number;
  /** Fraction of the beam width over which brightness falls to zero. */
  beamFalloff?: number;
  /** Frames the beams wander before converging. */
  searchFrames?: number;
  /** Frames spent drawing the beams to the centre. */
  convergeFrames?: number;
  /** Frames spent expanding the lit area over the whole label. */
  expandFrames?: number;
  /** Frames the label stays fully lit before the cycle repeats. */
  holdFrames?: number;
  /** Number of beams. */
  spotlightCount?: number;
  /** Beam speed range, in cells per frame. */
  speedRange?: [number, number];
  /** Seed for the beam layout, so a given size always starts the same way. */
  seed?: number;
};

const DEFAULTS: Required<SpotlightOptions> = {
  beamWidthRatio: 3,
  beamFalloff: 0.3,
  searchFrames: 46,
  convergeFrames: 14,
  expandFrames: 12,
  holdFrames: 26,
  spotlightCount: 3,
  speedRange: [0.35, 0.75],
  seed: 0x5eed,
};

type Beam = {
  center: number;
  velocity: number;
};

/** Mulberry32: tiny deterministic PRNG, so a rebuild reproduces the layout. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map brightness onto a ramp step. Zero is the floor, never invisible. */
function levelFor(brightness: number): number {
  if (brightness <= 0) return 0;
  const scaled = Math.ceil(brightness * (RAMP_LEVELS - 1));
  return Math.min(RAMP_LEVELS - 1, Math.max(1, scaled));
}

/**
 * The white light that rides the status box's border while the agent works.
 *
 * One bright head cell — the theme's brightest text token, emboldened so it
 * reads as a point of light rather than painted chrome — travels clockwise
 * along the box's frame, trailed by cells that fade toward the border tone.
 * The frame's own geometry decides the loop length, so the light conforms to
 * whatever box it is drawn on; nothing here touches the TUI.
 */
export class BorderLight {
  /** Cells of the border travelled so far; wrapped by the box's perimeter. */
  private travelled = 0;

  advance(): void {
    this.travelled += 1;
  }

  /** Restart at the top-left corner, so a fresh turn begins the lap there. */
  reset(): void {
    this.travelled = 0;
  }

  /** Frames travelled, exposed so callers can key caches on the position. */
  get step(): number {
    return this.travelled;
  }

  /**
   * The lit cell of the border, as a counterclockwise offset from the
   * bottom-right corner — the inner join of the frame's last drawn row — so
   * the caller can map it onto rows without knowing the loop length.
   */
  cellFromEnd(perimeter: number): number {
    if (perimeter < 1) return 0;
    return this.travelled % perimeter;
  }

  /** The tail's fade, 1 at the head and reaching 0 at the tail's end. */
  static tailFade(distance: number): number {
    if (distance <= 0) return 1;
    if (distance >= BORDER_LIGHT_TAIL) return 0;
    return 1 - distance / BORDER_LIGHT_TAIL;
  }
}

/**
 * How one border cell is drawn. `behind` is the counterclockwise distance the
 * head has moved past this cell: 0 at the head itself, growing along the
 * tail. The head and its first tail cells light up — the brightest token,
 * emboldened, so the head reads as a point of light rather than painted
 * chrome — and everything else keeps the frame's own tone. Without a theme
 * the glyphs stay unstyled; the head still has somewhere to be.
 */
export function borderLightGlyph(behind: number, theme: Theme | undefined, glyph: string): string {
  if (!theme || BorderLight.tailFade(behind) <= 0) return theme ? theme.fg("border", glyph) : glyph;
  return theme.bold(theme.fg("text", glyph));
}

export class SpotlightText {
  private verb: string;
  private readonly opts: Required<SpotlightOptions>;
  private readonly random: () => number;
  private beams: Beam[] = [];
  private convergeFrom: number[] = [];
  /** Length of the label currently being swept; beams live in this range. */
  private textWidth = 0;
  private frame = 0;
  private phase: SpotlightPhase = "search";
  private phaseFrame = 0;
  private done = false;
  private letteringCached?: { key: string; lines: string[] | undefined };

  constructor(verb: string, options: SpotlightOptions = {}) {
    this.verb = verb;
    this.opts = { ...DEFAULTS, ...options };
    this.random = mulberry32(this.opts.seed);
  }

  get currentPhase(): SpotlightPhase {
    return this.phase;
  }

  /** True once the hold has elapsed: the caller swaps the verb and restarts. */
  get finished(): boolean {
    return this.done;
  }

  get frameIndex(): number {
    return this.frame;
  }

  /** Width of one beam in cells, derived from the label it sweeps. */
  get beamWidth(): number {
    if (this.textWidth < 1) return 2;
    return Math.max(2, Math.round(this.textWidth / Math.max(1, this.opts.beamWidthRatio)));
  }

  /** Restart at frame zero, optionally with a new verb. */
  restart(verb: string = this.verb): void {
    this.verb = verb;
    this.frame = 0;
    this.phase = "search";
    this.phaseFrame = 0;
    this.done = false;
    this.convergeFrom = [];
    this.textWidth = 0;
    this.beams = [];
  }

  /** Advance one frame, moving the beams and stepping the phase machine. */
  advance(): void {
    if (this.done) return;
    this.frame += 1;
    this.phaseFrame += 1;

    if (this.phase === "search") {
      if (this.phaseFrame >= this.opts.searchFrames) {
        this.phase = "converge";
        this.phaseFrame = 0;
        // Freeze where each beam started so the draw to the centre is smooth
        // rather than a jump to the target.
        this.convergeFrom = this.beams.map((beam) => beam.center);
      }
    } else if (this.phase === "converge") {
      if (this.phaseFrame >= this.opts.convergeFrames) {
        this.phase = "expand";
        this.phaseFrame = 0;
      }
    } else if (this.phase === "expand") {
      if (this.phaseFrame >= this.opts.expandFrames) {
        this.phase = "hold";
        this.phaseFrame = 0;
      }
    } else if (this.phaseFrame >= this.opts.holdFrames) {
      this.done = true;
      return;
    }

    this.move();
  }

  /** The original text label. The spotlight itself signals activity. */
  label(): string {
    return this.verb;
  }

  /** One centred, painted line of exactly `cols` visible columns. */
  render(cols: number, theme?: Theme): string {
    return this.renderLabel(Math.max(0, Math.floor(cols)), this.label(), theme);
  }

  /** Centre fine dot-matrix lettering, falling back to the original text. */
  renderBox(cols: number, rows: number, theme?: Theme): string[] {
    const width = Math.max(0, Math.floor(cols));
    const height = Math.max(0, Math.floor(rows));
    if (height < 1) return [];
    if (width < 1) return Array.from({ length: height }, () => "");

    const label = this.label();
    const key = `${label}:${width}x${height}`;
    if (this.letteringCached?.key !== key) {
      // Prefer thicker two-dot strokes. If a long word needs the space, keep
      // the finer lettering rather than forcing it into a clipped heavy font,
      // and condense horizontally before giving up on dots entirely.
      const lines = fitWorkingLettering(label, width, height, 2)
        ?? fitWorkingLettering(label, width, height, 1)
        ?? fitCondensedLettering(label, width, height);
      this.letteringCached = { key, lines };
    }
    const lettering = this.letteringCached.lines;
    if (lettering) {
      const textCols = visibleWidth(lettering[0]!);
      if (textCols !== this.textWidth) this.layout(textCols);
      const levels = this.levels(textCols);
      const left = Math.floor((width - textCols) / 2);
      const right = width - textCols - left;
      // Keep the dots bold at every brightness level. The spotlight changes
      // their colour, not their weight, so unlit dots stay visibly substantial.
      return lettering.map((line) => " ".repeat(left) + this.paintLine(line, levels, theme, true) + " ".repeat(right));
    }

    const line = this.render(width, theme);
    const middle = Math.floor(height / 2);
    return Array.from({ length: height }, (_, row) => row === middle ? line : " ".repeat(width));
  }

  private renderLabel(width: number, label: string, theme?: Theme): string {
    if (width < 1) return "";
    // The width helper adds ANSI resets even to plain truncated text. Strip
    // them before grapheme painting; otherwise escapes become visible glyphs.
    const text = stripVTControlCharacters(truncateToWidth(label, width, ""));
    const textWidth = visibleWidth(text);
    if (textWidth !== this.textWidth) this.layout(textWidth);
    const start = Math.floor((width - textWidth) / 2);
    return " ".repeat(start) + this.paintLine(text, this.levels(textWidth), theme)
      + " ".repeat(width - textWidth - start);
  }

  /** Paint graphemes, not code points, and keep blank runs unstyled. */
  private paintLine(line: string, levels: number[], theme?: Theme, bold = false): string {
    const runs: string[] = [];
    let runLevel = -1;
    let runText = "";
    let col = 0;
    const flush = (): void => {
      if (runText) runs.push(this.paint(runLevel, runText, theme, bold));
      runText = "";
    };
    for (const char of cells(line)) {
      const level = char === " " ? -1 : (levels[col] ?? 0);
      if (level !== runLevel) {
        flush();
        runLevel = level;
      }
      runText += char;
      col += visibleWidth(char);
    }
    flush();
    return runs.join("");
  }

  /**
   * The ramp step for every character of the label, exposed so the effect can be
   * asserted without parsing escape sequences.
   */
  levels(textWidth = this.textWidth): number[] {
    const width = Math.max(0, Math.floor(textWidth));
    const out = new Array<number>(width);
    for (let index = 0; index < width; index++) out[index] = levelFor(this.brightness(index, width));
    return out;
  }

  private brightness(index: number, width: number): number {
    if (this.phase === "hold") return 1;
    const span = Math.max(1, width - 1);

    // The beams have merged by now, so expand is one beam at the centre whose
    // radius grows until it covers the label. It starts at the width the beams
    // had when they converged, so the hand-off does not flash the label dark.
    if (this.phase === "expand") {
      const progress = Math.min(1, this.phaseFrame / Math.max(1, this.opts.expandFrames));
      const from = this.beamWidth / 2;
      const to = width / 2 + 1;
      return this.profile(Math.abs(index - span / 2), from + (to - from) * progress);
    }

    let best = 0;
    const half = this.beamWidth / 2;
    for (const beam of this.beams) {
      const lit = this.profile(Math.abs(index - beam.center), half);
      if (lit > best) best = lit;
    }
    return best;
  }

  /** 1 across the beam's core, falling to 0 over the outer falloff band. */
  private profile(distance: number, half: number): number {
    if (half <= 0 || distance >= half) return 0;
    const fade = Math.max(1e-6, this.opts.beamFalloff * 2 * half);
    const core = half - fade;
    if (distance <= core) return 1;
    return (half - distance) / fade;
  }

  private move(): void {
    if (this.phase === "search") {
      const last = Math.max(0, this.textWidth - 1);
      if (last === 0) {
        for (const beam of this.beams) beam.center = 0;
        return;
      }
      for (const beam of this.beams) {
        beam.center += beam.velocity;
        // Bounce rather than wrap: a beam that leaves and reappears at the far
        // edge reads as a second beam arriving.
        if (beam.center < 0) {
          beam.center = -beam.center;
          beam.velocity = Math.abs(beam.velocity);
        } else if (beam.center > last) {
          beam.center = 2 * last - beam.center;
          beam.velocity = -Math.abs(beam.velocity);
        }
      }
      return;
    }

    if (this.phase === "converge") {
      const target = Math.max(0, this.textWidth - 1) / 2;
      const t = Math.min(1, this.phaseFrame / Math.max(1, this.opts.convergeFrames));
      const eased = t * t * (3 - 2 * t);
      this.beams.forEach((beam, index) => {
        const from = this.convergeFrom[index] ?? beam.center;
        beam.center = from + (target - from) * eased;
      });
    }
  }

  /** Lay the beams out for a label of this length. */
  private layout(textWidth: number): void {
    const previousWidth = this.textWidth;
    this.textWidth = Math.max(0, Math.floor(textWidth));
    if (this.textWidth < 1) {
      this.beams = [];
      this.convergeFrom = [];
      return;
    }
    const last = Math.max(0, this.textWidth - 1);
    // Resizing mid-sweep preserves beam positions and convergence progress
    // instead of randomly relaying the beams and flashing the word.
    if (previousWidth > 0 && this.beams.length > 0) {
      const scale = last / Math.max(1, previousWidth - 1);
      for (const beam of this.beams) beam.center = Math.max(0, Math.min(last, beam.center * scale));
      this.convergeFrom = this.convergeFrom.map((center) => center * scale);
      return;
    }
    this.convergeFrom = [];
    const [slow, fast] = this.opts.speedRange;
    this.beams = Array.from({ length: Math.max(1, this.opts.spotlightCount) }, () => ({
      center: this.random() * Math.max(1, last),
      velocity: (slow + this.random() * (fast - slow)) * (this.random() < 0.5 ? -1 : 1),
    }));
  }

  private paint(level: number, text: string, theme?: Theme, bold = false): string {
    if (level < 0 || !theme) return text;
    const token = RAMP_TOKENS[level] ?? "text";
    const painted = theme.fg(token, text);
    return bold || level === RAMP_LEVELS - 1 ? theme.bold(painted) : painted;
  }
}
