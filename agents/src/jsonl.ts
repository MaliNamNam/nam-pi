import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_BYTES = 64;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface JsonlRead {
	changed: boolean;
	missing: boolean;
	bytes: number;
	notice?: string;
}

/** An append-only cursor, not a repeatedly parsed tail or full-file snapshot. */
export class JsonlReader {
	private position = 0;
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private provisional?: string;
	private discarding = false;
	private identity?: string;
	private modified = 0;
	private checkpoint = Buffer.alloc(0);
	private reading?: Promise<JsonlRead>;

	readonly file: string;
	constructor(file: string) { this.file = file; }

	read(consume: (record: Record<string, unknown>) => void, reset: () => void): Promise<JsonlRead> {
		if (this.reading) return this.reading;
		this.reading = this.readRecords(consume, reset).finally(() => { this.reading = undefined; });
		return this.reading;
	}

	private clear(reset: () => void): void {
		this.position = 0;
		this.decoder = new StringDecoder("utf8");
		this.buffer = "";
		this.provisional = undefined;
		this.discarding = false;
		this.checkpoint = Buffer.alloc(0);
		reset();
	}

	private async readRecords(consume: (record: Record<string, unknown>) => void, reset: () => void): Promise<JsonlRead> {
		let handle;
		try { handle = await fs.open(this.file, "r"); }
		catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			if (this.identity !== undefined) this.clear(reset);
			this.identity = undefined;
			return { changed: false, missing: true, bytes: 0 };
		}
		try {
			const stat = await handle.stat();
			const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
			let replaced = identity !== this.identity || stat.size < this.position;
			if (!replaced && (stat.size !== this.position || stat.mtimeMs !== this.modified) && this.checkpoint.length) {
				const previous = Buffer.alloc(this.checkpoint.length);
				const { bytesRead } = await handle.read(previous, 0, previous.length, this.position - previous.length);
				replaced = bytesRead !== previous.length || !previous.equals(this.checkpoint);
			}
			if (replaced) this.clear(reset);
			this.identity = identity;
			this.modified = stat.mtimeMs;
			let bytes = 0;
			let notice: string | undefined;
			const parse = (line: string): boolean => {
				let record: unknown;
				try { record = JSON.parse(line); } catch { return false; }
				if (record && typeof record === "object" && !Array.isArray(record)) consume(record as Record<string, unknown>);
				return true;
			};
			while (this.position < stat.size) {
				const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - this.position));
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.position);
				if (!bytesRead) break;
				this.position += bytesRead;
				bytes += bytesRead;
				const actual = chunk.subarray(0, bytesRead);
				this.checkpoint = Buffer.concat([this.checkpoint, actual]).subarray(-CHECKPOINT_BYTES);
				this.buffer += this.decoder.write(actual);
				let start = 0;
				for (let end; (end = this.buffer.indexOf("\n", start)) !== -1;) {
					const line = this.buffer.slice(start, end);
					if (!this.discarding && line !== this.provisional) parse(line);
					this.provisional = undefined;
					this.discarding = false;
					start = end + 1;
				}
				this.buffer = this.buffer.slice(start);
				if (this.buffer.length > MAX_RECORD_BYTES) {
					this.buffer = "";
					this.discarding = true;
					notice = "(Skipped an oversized child log record.)";
				}
				// Catch-up reads must not monopolize the root's keyboard/render loop.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			// Accept a complete final record without LF, but never emit it twice
			// when the writer supplies its newline on the next refresh.
			if (!this.discarding && this.buffer && this.buffer !== this.provisional && parse(this.buffer)) this.provisional = this.buffer;
			return { changed: replaced || bytes > 0, missing: false, bytes, notice };
		} finally { await handle.close(); }
	}
}
