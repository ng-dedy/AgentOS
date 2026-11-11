"use client";

import { ArrowLeft, Plus, Send, Square, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AgentAvatar, ErrorNotice, JsonView, MockBadge } from "@/components/common";
import { Badge, Button, Card, Skeleton, Textarea } from "@/components/ui";
import { api, ApiRequestError, newIdempotencyKey } from "@/lib/api";
import { useApi, useEventStream } from "@/lib/hooks";
import type { AgentDetail, Conversation, RunEvent } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

interface ConvSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export default function ChatPage() {
  const { id: agentId } = useParams<{ id: string }>();
  const agent = useApi<AgentDetail>(`/agents/${agentId}`);
  const convs = useApi<ConvSummary[]>(`/agents/${agentId}/conversations`);
  const [convId, setConvId] = useState<string | null>(null);
  const conv = useApi<Conversation>(convId ? `/conversations/${convId}` : null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!convId && convs.data?.[0]) setConvId(convs.data[0].id);
  }, [convs.data, convId]);

  // Re-attach to an answer that is still in progress after a reload.
  useEffect(() => {
    if (conv.data?.activeTask && !taskId) setTaskId(conv.data.activeTask.id);
  }, [conv.data, taskId]);

  const finish = (e: RunEvent) => {
    if (e.type === "run.failed") setError(`The run failed: ${String((e.payload as { message?: string }).message ?? "")}`);
    setTaskId(null);
    setStreamText("");
    setActivity([]);
    void conv.reload();
  };

  useEventStream(taskId ? `/tasks/${taskId}/events/stream` : null, {
    onDelta: (e) => setStreamText((s) => s + String((e.payload as { text: string }).text)),
    onEvent: (e) => {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "model.output" || e.type === "model.retry") setStreamText("");
      if (e.type === "model.retry") setActivity((a) => [...a, `Provider error, retrying (attempt ${String(p.attempt)})…`]);
      if (e.type === "tool.requested") setActivity((a) => [...a, `Calling ${String(p.toolName)}…`]);
      if (e.type === "tool.completed") setActivity((a) => [...a, `${String(p.toolName)} returned a result`]);
      if (e.type === "tool.rejected" || e.type === "tool.failed") setActivity((a) => [...a, `${String(p.toolName)}: ${String(p.reason)}`]);
      if (e.type === "approval.required") setActivity((a) => [...a, `Waiting for approval of ${String(p.toolName)}`]);
      if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") finish(e);
    },
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv.data?.messages.length, streamText, activity.length]);

  const newConversation = async () => {
    const c = await api.post<ConvSummary>(`/agents/${agentId}/conversations`, {});
    await convs.reload();
    setConvId(c.id);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setError(null);
    try {
      let id = convId;
      if (!id) {
        const c = await api.post<ConvSummary>(`/agents/${agentId}/conversations`, {});
        id = c.id;
        setConvId(id);
        void convs.reload();
      }
      const r = await api.post<{ taskId: string }>(`/conversations/${id}/messages`, { content: draft }, { idempotencyKey: newIdempotencyKey() });
      setDraft("");
      setTaskId(r.taskId);
      await conv.reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not send the message");
    }
  };

  const stop = async () => {
    if (taskId) await api.post(`/tasks/${taskId}/cancel`);
  };

  if (!agent.data) return <Skeleton className="h-96" />;
  const messages = conv.data?.messages ?? [];

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col gap-4 lg:h-[calc(100dvh-4rem)]">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="Back to agent">
          <Link href={`/agents/${agentId}`}>
            <ArrowLeft />
          </Link>
        </Button>
        <AgentAvatar name={agent.data.name} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{agent.data.name}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {agent.data.provider}/{agent.data.model}
          </p>
        </div>
        {agent.data.isMock ? <MockBadge /> : null}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[220px_1fr]">
        <Card className="hidden min-h-0 flex-col overflow-hidden md:flex">
          <div className="border-b border-border p-2">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void newConversation()}>
              <Plus /> New conversation
            </Button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {(convs.data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    setConvId(c.id);
                    setTaskId(null);
                  }}
                  className={cn("w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary", c.id === convId && "bg-secondary")}
                >
                  <div className="truncate">{c.title}</div>
                  <div className="text-[10px] text-muted-foreground">{timeAgo(c.updatedAt)}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="chat-messages">
            {messages.length === 0 && !taskId ? <p className="py-12 text-center text-sm text-muted-foreground">Send a message to start.</p> : null}
            {messages.map((m) =>
              m.role === "tool" ? (
                <details key={m.id} className="ml-11 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs">
                  <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                    <Wrench className="size-3" /> Tool result from <span className="font-mono">{m.toolName}</span>
                    {m.isError ? <Badge variant="destructive">error</Badge> : <Badge variant="success">executed on server</Badge>}
                  </summary>
                  <JsonView value={safeJson(m.content)} className="mt-2" />
                </details>
              ) : m.role === "assistant" ? (
                <div key={m.id} className="flex gap-3">
                  <AgentAvatar name={agent.data!.name} className="size-8" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {m.content ? <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div> : null}
                    {m.toolCalls.map((c) => (
                      <div key={c.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                        <Wrench className="size-3" /> requested <span className="font-mono">{c.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-primary/15 px-3.5 py-2 text-sm">{m.content}</div>
                </div>
              ),
            )}
            {taskId ? (
              <div className="flex gap-3" data-testid="chat-streaming">
                <AgentAvatar name={agent.data.name} className="size-8" />
                <div className="min-w-0 flex-1 space-y-1">
                  {activity.map((a, i) => (
                    <div key={i} className="text-xs text-muted-foreground">
                      {a}
                    </div>
                  ))}
                  <div className="whitespace-pre-wrap text-sm">
                    {streamText}
                    <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-accent animate-pulse-dot" />
                  </div>
                </div>
              </div>
            ) : null}
            <div ref={bottom} />
          </div>
          {error ? <ErrorNotice message={error} className="mx-4 mb-2" /> : null}
          <form onSubmit={send} className="flex items-end gap-2 border-t border-border p-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Message ${agent.data.name}`}
              rows={2}
              className="min-h-0 resize-none"
              aria-label="Message"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {taskId ? (
              <Button type="button" variant="destructive" onClick={() => void stop()}>
                <Square /> Stop
              </Button>
            ) : (
              <Button type="submit" disabled={!draft.trim()}>
                <Send /> Send
              </Button>
            )}
          </form>
        </Card>
      </div>
    </div>
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
