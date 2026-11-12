// T12 — SSE 클라이언트 관리. notify·state 이벤트를 모든 연결에 브로드캐스트.
export interface SseClient {
  write: (raw: string) => void;
  close: () => void;
}

export class NotifyHub {
  private clients = new Set<SseClient>();

  add(client: SseClient): void {
    this.clients.add(client);
  }

  remove(client: SseClient): void {
    this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  // SSE 포맷: "event: <name>\ndata: <json>\n\n".
  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(payload);
      } catch {
        this.clients.delete(c); // 죽은 클라이언트 제거.
      }
    }
  }
}
