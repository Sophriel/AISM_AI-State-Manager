// T12 — SSE 클라이언트 관리. 클라이언트마다 작업(task)을 갖고, 작업별·lobby(시작 화면)별로 전달.
export interface SseClient {
  write: (raw: string) => void;
  close: () => void;
}

export class NotifyHub {
  private clients = new Map<SseClient, string | null>();

  add(client: SseClient, task: string | null = null): void {
    this.clients.set(client, task);
  }

  remove(client: SseClient): void {
    this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  // 특정 작업에 붙은 클라이언트 수.
  attachedCount(task: string): number {
    let n = 0;
    for (const t of this.clients.values()) if (t === task) n++;
    return n;
  }

  private writeTo(c: SseClient, payload: string): void {
    try {
      c.write(payload);
    } catch {
      this.clients.delete(c); // 죽은 클라이언트 제거.
    }
  }

  // SSE 포맷: "event: <name>\ndata: <json>\n\n".
  private payload(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  // 그 작업 클라이언트만.
  send(task: string, event: string, data: unknown): void {
    const p = this.payload(event, data);
    for (const [c, t] of this.clients) if (t === task) this.writeTo(c, p);
  }

  // 시작 화면(lobby) 클라이언트만.
  sendLobby(event: string, data: unknown): void {
    const p = this.payload(event, data);
    for (const [c, t] of this.clients) if (t === null) this.writeTo(c, p);
  }

  // 전원.
  sendAll(event: string, data: unknown): void {
    const p = this.payload(event, data);
    for (const c of this.clients.keys()) this.writeTo(c, p);
  }
}
