import type { RunId } from "./ids.js";

export interface StreamChunk {
  index: number;
  data: unknown;
  timestamp: string;
}

export interface StreamInfo {
  channel: string;
  runId: RunId;
  status: "open" | "closed";
  chunkCount: number;
  createdAt: string;
  closedAt?: string;
}

export interface Streamer {
  readonly streamFlushIntervalMs?: number;

  streams: {
    write(
      channel: string,
      runId: RunId,
      chunk: StreamChunk,
    ): Promise<void>;

    writeMulti?(
      chunks: Array<{ channel: string; runId: RunId; chunk: StreamChunk }>,
    ): Promise<void>;

    close(channel: string, runId: RunId): Promise<void>;

    get(channel: string, runId: RunId): Promise<StreamInfo | null>;

    list(runId: RunId): Promise<StreamInfo[]>;

    getChunks(
      channel: string,
      runId: RunId,
      since?: number,
    ): Promise<StreamChunk[]>;

    getInfo(
      channel: string,
      runId: RunId,
    ): Promise<StreamInfo | null>;
  };
}
