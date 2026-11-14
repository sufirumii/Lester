"use client";

/**
 * The Chat screen and the hardened markdown renderer it uses.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Safe markdown renderer
 *   2. Chat screen
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { default as ReactMarkdown } from "react-markdown";
import { apiDelete, apiGet, ssePost, type ChatMessage, type ConversationInfo, type InstalledModel, type ModelsResponse, useLester } from "@/lib/client";
import { Badge, Button, Input, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, Switch, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { toast } from "sonner";
import { Coins, FileText, Fingerprint, Menu, MessageSquare, Plus, Search, Send, ShieldAlert, ShieldCheck, Square, Zap } from "lucide-react";


// ═══ Safe markdown renderer ══════════════════════════════════════════════════════
// merged from src/components/console/SafeMarkdown.tsx

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export const SafeMarkdown = memo(function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="prose-lester text-sm leading-relaxed">
      <ReactMarkdown
        urlTransform={(url) => (isSafeUrl(url) ? url : "")}
        components={{
          a: ({ children, href }) => (
            <span className="underline decoration-border underline-offset-2 break-all" title={href ?? undefined}>
              {children}
            </span>
          ),
          img: () => null,
          script: () => null,
          iframe: () => null,
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code className="block font-mono text-xs bg-muted/60 border rounded-md p-3 my-2 overflow-x-auto whitespace-pre" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className="font-mono text-xs bg-muted/60 rounded px-1 py-0.5" {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse border border-border">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left bg-muted/40">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// ═══ Chat screen ═════════════════════════════════════════════════════════════════
// merged from src/components/console/ChatScreen.tsx

interface Draft {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  blocked?: boolean;
  id?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
  redactions?: number;
  citations?: { docName: string; snippet: string; score: number }[] | null;
  meta?: { tokensIn?: number; tokensOut?: number; latencyMs?: number; proofSeq?: number; tokensPerSec?: number };
}

export function ChatScreen() {
  const { user, workspaceId } = useLester();
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [modelKey, setModelKey] = useState<string>("");
  const [useKnowledge, setUseKnowledge] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const role = user?.role ?? "MEMBER";

  const usableModels = useMemo(
    () => models.filter((m) => m.installed && m.enabled && m.approved),
    [models]
  );

  const loadConversations = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await apiGet<{ conversations: ConversationInfo[] }>(`/api/conversations?workspaceId=${workspaceId}&q=${encodeURIComponent(search)}`);
      setConversations(r.conversations);
    } catch {
      /* ignore */
    }
  }, [workspaceId, search]);

  const loadModels = useCallback(async () => {
    try {
      const r = await apiGet<ModelsResponse>("/api/models");
      setModels(r.installed);
      setModelKey((prev) => prev || r.installed.find((m) => m.installed && m.approved && m.enabled)?.key || "");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadConversations();
    void loadModels();
  }, [loadConversations, loadModels]);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const r = await apiGet<{ conversation: { messages: ChatMessage[]; modelKey: string } }>(`/api/conversations/${id}`);
      setMessages(r.conversation.messages);
      if (r.conversation.modelKey) setModelKey(r.conversation.modelKey);
    } catch {
      toast.error("Could not load conversation.");
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadMessages(activeId);
    else setMessages([]);
  }, [activeId, loadMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [drafts, messages]);

  async function newConversation() {
    setActiveId(null);
    setMessages([]);
    setDrafts([]);
    setListOpen(false);
  }

  async function deleteConversation(id: string) {
    try {
      await apiDelete(`/api/conversations/${id}`);
      if (activeId === id) newConversation();
      void loadConversations();
      toast.success("Conversation deleted.");
    } catch {
      toast.error("Delete failed.");
    }
  }

  async function send() {
    const content = input.trim();
    if (!content || streaming || !modelKey || !workspaceId) return;
    if (role === "AUDITOR") return;
    setInput("");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const history = [...messages.filter((m) => !m.blocked).map((m) => ({ role: m.role, content: m.content })),
      ...drafts.filter((d) => !d.blocked).map((d) => ({ role: d.role, content: d.content }))];

    let assistantDraft: Draft = { role: "assistant", content: "", streaming: true };
    setDrafts((prev) => [...prev, { role: "user", content }, assistantDraft]);

    const updateLast = (patch: Partial<Draft>) => {
      setDrafts((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
        return copy;
      });
    };

    try {
      await ssePost(
        "/api/chat",
        { conversationId: activeId ?? undefined, workspaceId, modelKey, content, useKnowledge, history },
        (ev) => {
          const type = ev.type as string;
          if (type === "meta") {
            if (ev.conversationId && !activeId) {
              streamConvRef.current = ev.conversationId as string;
              setActiveId(streamConvRef.current);
            }
            if (ev.fallback) {
              assistantDraft = { ...assistantDraft, content: "" };
              updateLast({ content: "", meta: undefined });
              toast.info(`Local engine unreachable — routed to ${ev.label} (cloud fallback). Recorded in Proof.`);
            }
          } else if (type === "policy") {
            if (ev.blocked) {
              updateLast({ blocked: true, content: ev.reason as string, streaming: false });
            } else if ((ev.redactions as number) > 0) {
              toast.warning(`${ev.redactions} sensitive value${(ev.redactions as number) === 1 ? "" : "s"} redacted before dispatch — see Proof.`);
            }
          } else if (type === "citations") {
            updateLast({ citations: ev.hits as Draft["citations"] });
          } else if (type === "delta") {
            assistantDraft = { ...assistantDraft, content: assistantDraft.content + (ev.text as string) };
            updateLast({ content: assistantDraft.content });
          } else if (type === "done") {
            updateLast({
              streaming: false,
              meta: {
                tokensIn: (ev.usage as { promptTokens?: number } | undefined)?.promptTokens as number,
                tokensOut: (ev.usage as { completionTokens?: number } | undefined)?.completionTokens as number,
                latencyMs: ev.latencyMs as number,
                proofSeq: ev.proofSeq as number,
                tokensPerSec: ev.tokensPerSec as number,
              },
            });
          } else if (type === "error") {
            updateLast({ streaming: false, content: `${ev.message}\n\n${ev.recovery ?? ""}`.trim(), blocked: true });
            toast.error(ev.message as string);
          }
        },
        controller.signal
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        updateLast({ streaming: false, blocked: true, content: e instanceof Error ? e.message : "Request failed." });
      } else {
        updateLast({ streaming: false });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void loadConversations();
      const convId = streamConvRef.current ?? activeId;
      if (convId) {
        setTimeout(() => {
          void loadMessages(convId).then(() => setDrafts([]));
        }, 300);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const allMessages: (ChatMessage | Draft)[] = useMemo(() => {
    if (drafts.length > 0) {
      return [...messages, ...drafts];
    }
    return messages;
  }, [messages, drafts]);

  // Clear live drafts only when the user switches conversations manually —
  // not when activeId is set mid-stream from the server's meta event.
  const streamConvRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeId && streamConvRef.current !== activeId) {
      setDrafts([]);
    }
  }, [activeId]);

  const conversationList = (
    <div className="h-full flex flex-col">
      <div className="p-2 border-b flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations…"
            className="pl-8 h-8 text-xs"
            aria-label="Search conversations"
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={newConversation} aria-label="New conversation">
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {conversations.length === 0 && (
            <p className="text-xs text-muted-foreground p-3 text-center leading-relaxed">
              No conversations yet.
              <br />Start chatting — everything stays on this node.
            </p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group rounded-md text-xs px-2 py-2 cursor-pointer flex flex-col gap-0.5 ${activeId === c.id ? "bg-primary/10" : "hover:bg-accent"}`}
              onClick={() => {
                setActiveId(c.id);
                setListOpen(false);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && setActiveId(c.id)}
            >
              <div className="flex items-center gap-1.5">
                <MessageSquare className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-medium">{c.title}</span>
                <button
                  className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c.id);
                  }}
                  aria-label={`Delete ${c.title}`}
                >
                  ×
                </button>
              </div>
              <span className="text-[10px] text-muted-foreground pl-4.5">
                {new Date(c.updatedAt).toLocaleString()} · {c.messageCount} messages
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );

  return (
    <div className="h-full flex min-h-0">
      {/* Desktop conversation list */}
      <aside className="hidden lg:flex w-60 shrink-0 border-r bg-card/60 flex-col" aria-label="Conversations">
        {conversationList}
      </aside>

      {/* Chat column */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0" aria-label="Chat">
        {/* Header */}
        <div className="h-11 shrink-0 border-b bg-card/60 flex items-center gap-2 px-3">
          <Sheet open={listOpen} onOpenChange={setListOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Conversations">
                <Menu className="size-4" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72">
              <SheetHeader className="sr-only">
                <SheetTitle>Conversations</SheetTitle>
              </SheetHeader>
              {conversationList}
            </SheetContent>
          </Sheet>

          <Select value={modelKey} onValueChange={setModelKey}>
            <SelectTrigger className="h-8 w-auto max-w-52 text-xs gap-1" aria-label="Model">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {usableModels.map((m) => (
                <SelectItem key={m.key} value={m.key} className="text-xs">
                  {m.name}
                  {m.provider === "CLOUD" ? " ☁" : ""}
                </SelectItem>
              ))}
              {usableModels.length === 0 && <div className="p-2 text-xs text-muted-foreground">No approved models installed.</div>}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5 cursor-pointer" title="Answer from this workspace's documents (on-device retrieval)">
              <FileText className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Knowledge</span>
              <Switch checked={useKnowledge} onCheckedChange={setUseKnowledge} aria-label="Use workspace knowledge" />
            </label>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <div className="max-w-3xl mx-auto p-4 space-y-4">
            {allMessages.length === 0 && (
              <div className="text-center py-16 space-y-3">
                <ShieldCheck className="size-10 mx-auto text-primary/40" aria-hidden />
                <h2 className="text-base font-medium">Private chat on this node</h2>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
                  Messages run through workspace policy, are redacted if needed, and every turn lands in the Proof ledger.
                  {role === "AUDITOR" && " Your auditor account is read-only — inspect the Proof tab instead."}
                </p>
              </div>
            )}
            {allMessages.map((m, i) => {
              const isUser = m.role === "user";
              const isDraft = "streaming" in m;
              const blocked = "blocked" in m ? m.blocked : false;
              const citations = m.citations ?? null;
              return (
                <div key={m.id ?? `d${i}`} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] sm:max-w-[75%] space-y-1.5 ${isUser ? "items-end" : "items-start"} flex flex-col`}>
                    <div
                      className={`rounded-xl px-3.5 py-2.5 text-sm break-words ${
                        blocked
                          ? "border border-destructive/40 bg-destructive/5 text-destructive whitespace-pre-wrap"
                          : isUser
                            ? "bg-primary text-primary-foreground whitespace-pre-wrap"
                            : "bg-card border"
                      } ${"streaming" in m && m.streaming ? "stream-caret" : ""}`}
                    >
                      {isUser || blocked ? (
                        m.content
                      ) : (
                        <SafeMarkdown text={m.content} />
                      )}
                    </div>
                    {citations && citations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {citations.map((c, ci) => (
                          <Tooltip key={ci}>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="text-[10px] gap-1 cursor-help max-w-56">
                                <FileText className="size-3" aria-hidden />
                                <span className="truncate">{c.docName}</span>
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-80 text-xs">
                              <p className="line-clamp-4">{c.snippet}</p>
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                    {!isUser && !blocked && (m.tokensOut || m.latencyMs || ("meta" in m && m.meta)) && (
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular">
                        {m.tokensIn != null && m.tokensOut != null && !isDraft && (
                          <span className="flex items-center gap-0.5"><Coins className="size-3" aria-hidden />{m.tokensIn}→{m.tokensOut} tok</span>
                        )}
                        {m.latencyMs != null && !isDraft && (
                          <span className="flex items-center gap-0.5"><Zap className="size-3" aria-hidden />{m.latencyMs} ms</span>
                        )}
                        {"meta" in m && m.meta && (
                          <>
                            <span className="flex items-center gap-0.5"><Coins className="size-3" aria-hidden />{m.meta.tokensIn}→{m.meta.tokensOut} tok</span>
                            <span className="flex items-center gap-0.5"><Zap className="size-3" aria-hidden />{m.meta.latencyMs} ms · {m.meta.tokensPerSec} tok/s</span>
                            <span className="flex items-center gap-0.5"><Fingerprint className="hidden" aria-hidden />proof #{m.meta.proofSeq}</span>
                          </>
                        )}
                        {(m.redactions ?? 0) > 0 && (
                          <span className="flex items-center gap-0.5 text-amber-700 dark:text-amber-400">
                            <ShieldAlert className="size-3" aria-hidden />{m.redactions ?? 0} redacted
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t bg-card/60 p-3">
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={role === "AUDITOR" ? "Auditor accounts are read-only…" : `Message ${usableModels.find((m) => m.key === modelKey)?.name ?? "model"}…`}
              rows={Math.min(4, Math.max(1, input.split("\n").length))}
              disabled={role === "AUDITOR" || usableModels.length === 0}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-9 max-h-32 scrollbar-thin"
              aria-label="Message"
            />
            {streaming ? (
              <Button size="icon" variant="outline" onClick={stop} aria-label="Stop generating">
                <Square className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button size="icon" onClick={() => void send()} disabled={!input.trim() || !modelKey || role === "AUDITOR"} aria-label="Send message">
                <Send className="size-4" aria-hidden />
              </Button>
            )}
          </div>
          <p className="max-w-3xl mx-auto text-[10px] text-muted-foreground mt-1.5 hidden sm:block">
            Policy applies before dispatch · redaction on · every turn recorded in Proof
          </p>
        </div>
      </section>
    </div>
  );
}
