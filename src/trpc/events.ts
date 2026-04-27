import { EventEmitter } from "node:events";

export interface TrpcEventPayload {
  event: string;
  data: unknown;
  at: number;
}

const emitter = new EventEmitter();

export function publishTrpcEvent(event: string, data: unknown): void {
  emitter.emit("event", { event, data, at: Date.now() } satisfies TrpcEventPayload);
}

export function subscribeTrpcEvents(onEvent: (payload: TrpcEventPayload) => void): () => void {
  emitter.on("event", onEvent);
  return () => {
    emitter.off("event", onEvent);
  };
}
