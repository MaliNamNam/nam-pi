import { AssistantMessageComponent, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { chromePaint, frameRow, inscribedBorder, inscribedTitle } from "./composer.ts";

const FRAME_CHILD = Symbol.for("pi-side-panel.conversation-frame-child");
const FRAME_HOOK = Symbol.for("pi-side-panel.conversation-frame-hook");
const GUTTER = 3;
const TITLE_COLUMN = 3; // Corner, dash, then space before the emoji.
const MIN_FRAME_WIDTH = 8;
const RESET = "\x1b[0m";

type FrameOwner = { active: boolean; theme: () => Theme };
type FramedChild = Component & { [FRAME_CHILD]?: Component };

function frameLayout(width: number, right: boolean) {
  const framed = width >= MIN_FRAME_WIDTH;
  const gutter = framed ? Math.min(GUTTER, width - MIN_FRAME_WIDTH) : 0;
  return { framed, width: width - gutter, left: right ? gutter : 0, right: right ? 0 : gutter };
}

/** Keep Pi's Markdown, styling, transformers and thinking mouse region intact. */
class ConversationFrame implements Component {
  readonly [FRAME_CHILD]: Component;
  private contentHeight = 0;
  private cache?: { width: number; rows: string[]; theme: Theme; lines: string[] };

  constructor(
    readonly child: Component,
    readonly owner: FrameOwner,
    private readonly title: string,
    private readonly rightAligned = false,
    private readonly collapsedThinking = false,
  ) {
    this[FRAME_CHILD] = child;
  }

  render(width: number): string[] {
    if (!this.owner.active) return this.child.render(width);
    if (width <= 0) return [];
    if (this.collapsedThinking) return [truncateToWidth(`${" ".repeat(TITLE_COLUMN)}${this.title}`, width, "", true)];
    const layout = frameLayout(width, this.rightAligned);
    const inner = layout.framed ? layout.width - 2 : width;
    const rows = this.child.render(inner);
    this.contentHeight = rows.length;
    if (!layout.framed) return rows.map((row) => truncateToWidth(row, width, "", true));
    if (!rows.length) return [];
    const theme = this.owner.theme();
    // Pi renders the transcript every frame; children return the same cached
    // rows until their content changes, so reuse the framed copy until then.
    const cached = this.cache;
    if (cached && cached.width === width && cached.rows === rows && cached.theme === theme) return cached.lines;

    const paint = chromePaint(theme);
    const top = this.rightAligned
      ? inscribedBorder("", ` ${this.title} ${paint("─")}`, layout.width, paint, "╭", "╮")
      : inscribedTitle(this.title, layout.width, paint, "top");
    const lines = [
      top,
      ...rows.map((row) => frameRow(`${truncateToWidth(row, inner, "", false)}${RESET}`, layout.width, paint)),
      inscribedTitle("", layout.width, paint, "bottom"),
    ];
    const left = " ".repeat(layout.left);
    const right = " ".repeat(layout.right);
    const framed = lines.map((line) => `${RESET}${left}${line}${RESET}${right}`);
    this.cache = { width, rows, theme, lines: framed };
    return framed;
  }

  invalidate(): void {
    this.cache = undefined;
    this.child.invalidate();
  }
  handleInput(data: string): void { this.child.handleInput?.(data); }

  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]): ReturnType<NonNullable<Component["handleMouse"]>> {
    if (!this.owner.active) return this.child.handleMouse?.(event);
    if (this.collapsedThinking) {
      if (event.y !== 0 || event.x < TITLE_COLUMN || event.x >= Math.min(TITLE_COLUMN + visibleWidth(this.title), event.width)) return undefined;
      return this.child.handleMouse?.({ ...event, x: event.x - TITLE_COLUMN });
    }
    const layout = frameLayout(event.width, this.rightAligned);
    const x = event.x - layout.left - (layout.framed ? 1 : 0);
    const y = event.y - (layout.framed ? 1 : 0);
    const width = layout.framed ? layout.width - 2 : event.width;
    const titleX = layout.left + TITLE_COLUMN;
    if (this.title === "🧠" && layout.framed && event.y === 0 && event.x >= titleX && event.x < titleX + visibleWidth(this.title)) {
      return this.child.handleMouse?.({ ...event, x: 0, y: 0, width, height: this.contentHeight });
    }
    if (x < 0 || x >= width || y < 0 || y >= this.contentHeight) return undefined;
    return this.child.handleMouse?.({ ...event, x, y, width, height: this.contentHeight });
  }
}

function wrapChildren(container: Container, owner: FrameOwner, user: boolean): void {
  for (let index = 0; index < container.children.length; index++) {
    const current = container.children[index]!;
    if (current instanceof ConversationFrame && current.owner === owner) continue;
    // A previous /reload may have left inactive wrappers on existing messages.
    const child = (current as FramedChild)[FRAME_CHILD] ?? current;
    if (child instanceof Spacer) continue;
    const thinking = child instanceof MouseRegion;
    const collapsedThinking = thinking && (child as unknown as { child: Component }).child instanceof Text;
    container.children[index] = new ConversationFrame(child, owner, user ? "👤" : thinking ? "🧠" : "🤖", user, collapsedThinking);
  }
}

/** Pi has no built-in message renderer API; guard this display-only seam. */
export function installConversationFrames(theme: () => Theme): (() => void) | undefined {
  const user = UserMessageComponent.prototype as UserMessageComponent & { [FRAME_HOOK]?: () => void };
  const assistant = AssistantMessageComponent.prototype;
  if (typeof user.render !== "function" || typeof assistant.render !== "function") return undefined;
  const content = new AssistantMessageComponent().children[0];
  if (!(content instanceof Container)) return undefined;

  user[FRAME_HOOK]?.();
  const owner: FrameOwner = { active: true, theme };
  const originalUser = user.render;
  const originalAssistant = assistant.render;
  const renderUser = function (this: UserMessageComponent, width: number): string[] {
    wrapChildren(this, owner, true);
    return originalUser.call(this, width);
  };
  const renderAssistant = function (this: AssistantMessageComponent, width: number): string[] {
    const container = this.children[0];
    if (container instanceof Container) wrapChildren(container, owner, false);
    return originalAssistant.call(this, width);
  };
  user.render = renderUser;
  assistant.render = renderAssistant;
  const uninstall = () => {
    owner.active = false;
    if (user.render === renderUser) user.render = originalUser;
    if (assistant.render === renderAssistant) assistant.render = originalAssistant;
    if (user[FRAME_HOOK] === uninstall) delete user[FRAME_HOOK];
  };
  user[FRAME_HOOK] = uninstall;
  return uninstall;
}
