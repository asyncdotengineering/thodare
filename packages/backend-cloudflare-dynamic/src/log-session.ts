/**
 * LogSession Durable Object — per-run ring buffer (multi-channel) with
 * WebSocket fan-out for live run streaming.
 *
 * Keyed by `runId`. Each DO instance handles all channels for one run.
 * Chunks are persisted to DO storage so reconnecting clients see history.
 *
 * Ref: dynamic-workflows example at examples/basic/src/logging.ts:73+
 */

import { DurableObject } from "cloudflare:workers";
import type { StreamChunk, StreamInfo, RunId } from "@thodare/backend";

const MAX_CHUNKS_PER_CHANNEL = 1000;

function isoNow(): string {
  return new Date().toISOString();
}

interface ChannelState {
  chunks: StreamChunk[];
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
}

interface SessionStore {
  channels: Record<string, ChannelState>;
}

export class LogSession extends DurableObject {
  private channels = new Map<string, ChannelState>();
  private subscribers = new Map<string, Set<WebSocket>>();
  private hydrated = false;

  private get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const stored = await this.storage.get<SessionStore>("session");
    if (stored?.channels) {
      for (const [name, cs] of Object.entries(stored.channels)) {
        this.channels.set(name, cs);
        this.subscribers.set(name, new Set());
      }
    }
    this.hydrated = true;
  }

  private ensureChannel(channel: string): ChannelState {
    let cs = this.channels.get(channel);
    if (!cs) {
      cs = { chunks: [], status: "open", createdAt: isoNow() };
      this.channels.set(channel, cs);
      this.subscribers.set(channel, new Set());
    }
    return cs;
  }

  private async persist(): Promise<void> {
    const channels: Record<string, ChannelState> = {};
    for (const [name, cs] of this.channels) {
      channels[name] = cs;
    }
    await this.storage.put<SessionStore>("session", { channels });
  }

  // ── HTTP fetch: WebSocket upgrade ──

  override async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") ?? "default";

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.handleSession(channel, pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("expected websocket", { status: 426 });
  }

  private handleSession(channel: string, ws: WebSocket): void {
    const cs = this.ensureChannel(channel);
    let subs = this.subscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(channel, subs);
    }
    subs.add(ws);

    // Replay history
    if (cs.chunks.length > 0) {
      for (const chunk of cs.chunks) {
        ws.send(JSON.stringify(chunk));
      }
    }

    if (cs.status === "closed") {
      ws.send(JSON.stringify({ type: "done" }));
      ws.close(1000, "session closed");
      subs.delete(ws);
      return;
    }

    ws.addEventListener("close", () => subs?.delete(ws));
    ws.addEventListener("error", () => subs?.delete(ws));
    ws.accept();
  }

  // ── RPC entry points ──

  async push(channel: string, chunk: StreamChunk): Promise<void> {
    await this.hydrate();
    const cs = this.ensureChannel(channel);
    if (cs.status === "closed") return;

    cs.chunks.push(chunk);
    if (cs.chunks.length > MAX_CHUNKS_PER_CHANNEL) {
      cs.chunks = cs.chunks.slice(-MAX_CHUNKS_PER_CHANNEL);
    }
    await this.persist();

    const payload = JSON.stringify(chunk);
    const subs = this.subscribers.get(channel);
    if (subs) {
      const dead: WebSocket[] = [];
      for (const ws of subs) {
        try {
          ws.send(payload);
        } catch {
          dead.push(ws);
        }
      }
      for (const ws of dead) subs.delete(ws);
    }
  }

  async getChunks(channel: string, since?: number): Promise<StreamChunk[]> {
    await this.hydrate();
    const cs = this.channels.get(channel);
    if (!cs) return [];
    if (since === undefined || since < 0) return [...cs.chunks];
    return cs.chunks.filter((c) => c.index > since);
  }

  async getInfo(channel: string, runId: RunId): Promise<StreamInfo | null> {
    await this.hydrate();
    const cs = this.channels.get(channel);
    if (!cs) return null;
    return {
      channel,
      runId,
      status: cs.status,
      chunkCount: cs.chunks.length,
      createdAt: cs.createdAt,
      ...(cs.closedAt ? { closedAt: cs.closedAt } : {}),
    };
  }

  async closeChannel(channel: string): Promise<void> {
    await this.hydrate();
    const cs = this.channels.get(channel);
    if (!cs || cs.status === "closed") return;
    cs.status = "closed";
    cs.closedAt = isoNow();
    await this.persist();

    const donePayload = JSON.stringify({ type: "done" });
    const subs = this.subscribers.get(channel);
    if (subs) {
      for (const ws of subs) {
        try {
          ws.send(donePayload);
          ws.close(1000, "session closed");
        } catch {
          // ignore
        }
      }
      subs.clear();
    }
  }

  async list(runId: RunId): Promise<StreamInfo[]> {
    await this.hydrate();
    const infos: StreamInfo[] = [];
    for (const [channel, cs] of this.channels) {
      infos.push({
        channel,
        runId,
        status: cs.status,
        chunkCount: cs.chunks.length,
        createdAt: cs.createdAt,
        ...(cs.closedAt ? { closedAt: cs.closedAt } : {}),
      });
    }
    return infos;
  }
}
