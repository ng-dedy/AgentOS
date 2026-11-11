"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvent } from "@agentos/contracts";
import { api, API_URL, ApiRequestError } from "./api";

/** Minimal data hook: fetch on mount and on `reload()`. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api.get<T>(path);
      if (mounted.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiRequestError ? e : new ApiRequestError(0, "network", "Could not reach the API"));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    setLoading(path !== null);
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload, path]);

  return { data, error, loading, reload, setData };
}

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

/**
 * Subscribe to an SSE endpoint. Persisted events (with seq) are de-duplicated,
 * so a reconnect that replays from Last-Event-ID never shows an event twice.
 * Live-only token deltas are passed to `onDelta`.
 */
export function useEventStream(path: string | null, opts: { onEvent?: (e: RunEvent) => void; onDelta?: (e: RunEvent) => void } = {}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>("connecting");
  const seen = useRef(new Set<string>());
  const handlers = useRef(opts);
  handlers.current = opts;

  useEffect(() => {
    if (!path) return;
    seen.current = new Set();
    setEvents([]);
    setState("connecting");
    const es = new EventSource(`${API_URL}/api/v1${path}`, { withCredentials: true });
    const onMessage = (msg: MessageEvent<string>) => {
      const ev = JSON.parse(msg.data) as RunEvent;
      if (ev.seq === null) {
        handlers.current.onDelta?.(ev);
        return;
      }
      if (seen.current.has(ev.seq)) return;
      seen.current.add(ev.seq);
      setEvents((prev) => [...prev, ev]);
      handlers.current.onEvent?.(ev);
    };
    const types = [
      "task.created",
      "task.status",
      "run.started",
      "model.delta",
      "model.output",
      "tool.requested",
      "tool.rejected",
      "approval.required",
      "approval.decided",
      "tool.completed",
      "tool.failed",
      "agent.handoff",
      "usage.recorded",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ];
    for (const t of types) es.addEventListener(t, onMessage as EventListener);
    es.addEventListener("replay.done", () => setState("live"));
    es.onopen = () => setState((s) => (s === "reconnecting" ? "live" : s));
    es.onerror = () => setState(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    return () => {
      es.close();
    };
  }, [path]);

  return { events, state };
}
