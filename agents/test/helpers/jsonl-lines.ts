import { StringDecoder } from "node:string_decoder";

/** LF-only framing: scan each chunk once and join fragments only at a boundary. */
export class JsonlLines {
  #decoder = new StringDecoder("utf8");
  #parts: string[] = [];
  #consume: (line: string) => void;

  constructor(consume: (line: string) => void) { this.#consume = consume; }

  push(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    let start = 0;
    for (let end; (end = text.indexOf("\n", start)) !== -1;) {
      this.#parts.push(text.slice(start, end));
      this.#emit();
      start = end + 1;
    }
    if (start < text.length) this.#parts.push(text.slice(start));
  }

  end() {
    this.push(this.#decoder.end());
    if (this.#parts.length) this.#emit();
  }

  #emit() {
    const line = this.#parts.join("");
    this.#parts = [];
    this.#consume(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}
