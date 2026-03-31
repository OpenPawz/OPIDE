// IPC Bridge — Content-Length framed JSON-RPC over stdin/stdout.
// Same wire format as LSP/DAP, matching the Rust side in extension_host.rs.

export type MessageHandler = (msg: any) => void;

export class IpcBridge {
  private buffer = '';
  private handlers: MessageHandler[] = [];
  private contentLength = -1;

  constructor() {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => {
      this.log('stdin closed — shutting down');
      process.exit(0);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  send(msg: any): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
    process.stdout.write(header + json);
  }

  log(message: string): void {
    // Write to stderr so it doesn't interfere with the JSON-RPC protocol on stdout
    process.stderr.write(`[ext-host] ${message}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      if (this.contentLength === -1) {
        // Looking for Content-Length header
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // Need more data

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Bad header — skip past it
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      // We know the content length — do we have enough data?
      const bodyBytes = Buffer.byteLength(this.buffer, 'utf-8');
      if (bodyBytes < this.contentLength) return; // Need more data

      // Extract the body (handle multi-byte characters correctly)
      const bodyBuf = Buffer.from(this.buffer, 'utf-8');
      const json = bodyBuf.slice(0, this.contentLength).toString('utf-8');
      this.buffer = bodyBuf.slice(this.contentLength).toString('utf-8');
      this.contentLength = -1;

      try {
        const msg = JSON.parse(json);
        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch (e) {
        this.log(`Failed to parse message: ${e}`);
      }
    }
  }
}
