"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import type { ConversationWithLastMessage, Message, MessageStatus } from "@/lib/types";

function StatusTicks({ status }: { status: MessageStatus | null }) {
  if (!status) return null;
  if (status === "failed") {
    return (
      <span className="text-red-400" title="Failed to deliver">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>
    );
  }
  const single = status === "sent";
  const colorClass = status === "read" ? "text-sky-300" : "text-white/50";
  return (
    <span className={colorClass} title={status}>
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0.5 5 L3.5 8 L9.5 1.5" />
        {!single && <path d="M5.5 5 L7.5 7.5 L13.5 1.5" />}
      </svg>
    </span>
  );
}

export default function Dashboard() {
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
  }, []);

  const [conversations, setConversations] = useState<ConversationWithLastMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachedPreview, setAttachedPreview] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isInitialMessagesLoadRef = useRef(true);

  const selected = conversations.find((c) => c.id === selectedId);

  const fetchConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data);
  }, []);

  const fetchMessages = useCallback(async (convoId: string) => {
    const res = await fetch(`/api/conversations/${convoId}/messages?limit=50`);
    const data = await res.json();
    setMessages(data.messages ?? []);
    setHasMore(!!data.has_more);
  }, []);

  const loadOlder = useCallback(async () => {
    if (!selectedId || loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    const oldest = messages[0].created_at;
    const scrollEl = messagesScrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    try {
      const res = await fetch(
        `/api/conversations/${selectedId}/messages?limit=50&before=${encodeURIComponent(oldest)}`
      );
      const data = await res.json();
      const older: Message[] = data.messages ?? [];
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasMore(!!data.has_more);
      // Preserve scroll position so the new content doesn't snap to top
      requestAnimationFrame(() => {
        const el = messagesScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedId, loadingOlder, hasMore, messages]);

  const markRead = useCallback(async (convoId: string) => {
    await fetch(`/api/conversations/${convoId}/mark-read`, { method: "POST" });
    setConversations((prev) =>
      prev.map((c) => (c.id === convoId ? { ...c, unread_count: 0 } : c))
    );
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    if (!selectedId) return;
    isInitialMessagesLoadRef.current = true;
    fetchMessages(selectedId);
    markRead(selectedId);
  }, [selectedId, fetchMessages, markRead]);

  useEffect(() => {
    if (loadingOlder || messages.length === 0) return;
    if (isInitialMessagesLoadRef.current) {
      // Conversation just switched — jump instantly, no animation
      const el = messagesScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      isInitialMessagesLoadRef.current = false;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loadingOlder]);

  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("realtime-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const newMsg = payload.new as Message;
          if (newMsg.conversation_id === selectedId) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            // If a new inbound message arrives while chat is open, mark read
            if (newMsg.role === "user") markRead(selectedId);
          }
          fetchConversations();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        (payload) => {
          const updated = payload.new as Message;
          if (updated.conversation_id === selectedId) {
            setMessages((prev) =>
              prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m))
            );
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => fetchConversations()
      )
      .subscribe();

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [selectedId, fetchConversations, supabase, markRead]);

  async function toggleMode() {
    if (!selected) return;
    const newMode = selected.mode === "agent" ? "human" : "agent";
    await fetch(`/api/conversations/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    });
    setConversations((prev) =>
      prev.map((c) => (c.id === selected.id ? { ...c, mode: newMode } : c))
    );
  }

  async function handleSend() {
    if (!selectedId || sending) return;
    if (!input.trim() && !attachedFile) return;
    setSending(true);
    try {
      if (attachedFile) {
        const fd = new FormData();
        fd.append("file", attachedFile);
        if (input.trim()) fd.append("caption", input.trim());
        await fetch(`/api/conversations/${selectedId}/send-media`, {
          method: "POST",
          body: fd,
        });
      } else {
        await fetch(`/api/conversations/${selectedId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: input.trim() }),
        });
      }
      setInput("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      clearAttachment();
      fetchMessages(selectedId);
    } finally {
      setSending(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedFile(file);
    if (file.type.startsWith("image/")) {
      setAttachedPreview(URL.createObjectURL(file));
    } else {
      setAttachedPreview(null);
    }
    e.target.value = "";
  }

  function clearAttachment() {
    setAttachedFile(null);
    if (attachedPreview) URL.revokeObjectURL(attachedPreview);
    setAttachedPreview(null);
  }

  function formatTime(dateStr: string) {
    return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getInitials(name: string | null, phone: string) {
    if (name) return name.slice(0, 2).toUpperCase();
    return phone.slice(-2);
  }

  return (
    <div className="flex h-screen bg-[#0f0f0f] font-sans">
      {/* Sidebar */}
      <div className="w-[320px] flex flex-col border-r border-white/[0.06]" style={{ background: "#141414" }}>
        {/* Sidebar Header */}
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold text-white leading-tight">WhatsApp AI Agent</h1>
              <p className="text-xs text-white/40 leading-tight mt-0.5">{conversations.length} conversation{conversations.length !== 1 ? "s" : ""}</p>
            </div>
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-xs text-white/30">No conversations yet</p>
            </div>
          )}
          {conversations.map((convo) => {
            const isSelected = selectedId === convo.id;
            return (
              <button
                key={convo.id}
                onClick={() => setSelectedId(convo.id)}
                className={`w-full text-left px-4 py-3.5 transition-all duration-150 relative group ${
                  isSelected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"
                }`}
              >
                {isSelected && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 bg-emerald-500 rounded-r" />
                )}
                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-800 flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold">
                    {getInitials(convo.name, convo.phone)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white/90 truncate">
                        {convo.name || convo.phone}
                      </span>
                      <span className="text-[10px] text-white/30 flex-shrink-0">
                        {formatTime(convo.updated_at)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      {convo.last_message ? (
                        <p className="text-xs text-white/40 truncate">{convo.last_message}</p>
                      ) : (
                        <span />
                      )}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {convo.unread_count > 0 && (
                          <span className="text-[10px] min-w-[18px] h-[18px] px-1.5 rounded-full bg-emerald-500 text-white font-semibold flex items-center justify-center">
                            {convo.unread_count > 99 ? "99+" : convo.unread_count}
                          </span>
                        )}
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${
                            convo.mode === "agent"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-amber-500/20 text-amber-400"
                          }`}
                        >
                          {convo.mode === "agent" ? "AI" : "You"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Chat Panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-white/40">Select a conversation</p>
              <p className="text-xs text-white/20 mt-1">Choose from the list to start chatting</p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between" style={{ background: "#141414" }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-800 flex items-center justify-center text-white text-xs font-semibold">
                  {getInitials(selected.name, selected.phone)}
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white leading-tight">
                    {selected.name || selected.phone}
                  </h2>
                  <p className="text-xs text-white/40 leading-tight mt-0.5">{selected.phone}</p>
                </div>
              </div>
              <button
                onClick={toggleMode}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                  selected.mode === "agent"
                    ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20"
                    : "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/20"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${selected.mode === "agent" ? "bg-emerald-400" : "bg-amber-400"}`} />
                {selected.mode === "agent" ? "AI Mode" : "Human Mode"}
              </button>
            </div>

            {/* Messages */}
            <div
              ref={messagesScrollRef}
              className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
              style={{
                backgroundImage: "radial-gradient(circle at 20% 80%, rgba(16,185,129,0.03) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(16,185,129,0.02) 0%, transparent 50%)",
              }}
            >
              {hasMore && (
                <div className="flex justify-center">
                  <button
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="text-[11px] text-white/50 hover:text-white/80 px-3 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] transition-colors disabled:opacity-50"
                  >
                    {loadingOlder ? "Loading..." : "Load older messages"}
                  </button>
                </div>
              )}
              {messages.map((msg, i) => {
                const isUser = msg.role === "user";
                const showTime = i === messages.length - 1 || messages[i + 1]?.role !== msg.role;
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isUser ? "justify-start" : "justify-end"}`}
                  >
                    <div className={`flex flex-col ${isUser ? "items-start" : "items-end"} max-w-[65%]`}>
                      <div
                        className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                          isUser
                            ? "bg-white/[0.07] text-white/90 rounded-tl-sm border border-white/[0.06]"
                            : "bg-emerald-600 text-white rounded-tr-sm"
                        }`}
                      >
                        {msg.media_url && msg.media_type === "image" && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={msg.media_url}
                            alt={msg.content || "image"}
                            className="rounded-lg max-w-full max-h-80 mb-1.5 cursor-pointer"
                            onClick={() => window.open(msg.media_url!, "_blank")}
                          />
                        )}
                        {msg.media_url && msg.media_type === "audio" && (
                          <audio controls src={msg.media_url} className="mb-1.5 max-w-full" />
                        )}
                        {msg.media_url && msg.media_type === "document" && (
                          <a
                            href={msg.media_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded bg-black/20 hover:bg-black/30 transition"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span className="text-xs underline">Open document</span>
                          </a>
                        )}
                        {msg.content && (
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        )}
                        {!msg.content && msg.transcript && (
                          <p className="whitespace-pre-wrap italic opacity-80 text-xs">
                            {msg.transcript}
                          </p>
                        )}
                      </div>
                      {showTime && (
                        <p className="text-[10px] text-white/25 mt-1.5 px-1 flex items-center gap-1">
                          {!isUser && (
                            msg.sent_by_ai ? (
                              <span className="text-emerald-500/60">AI ·</span>
                            ) : (
                              <span className="text-amber-400/70">You ·</span>
                            )
                          )}
                          <span>{formatTime(msg.created_at)}</span>
                          {!isUser && <StatusTicks status={msg.status} />}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              {(() => {
                const lastMsg = messages[messages.length - 1];
                const aiTyping =
                  selected?.mode === "agent" &&
                  lastMsg?.role === "user" &&
                  Date.now() - new Date(lastMsg.created_at).getTime() < 120_000;
                if (!aiTyping) return null;
                return (
                  <div className="flex justify-end">
                    <div className="flex flex-col items-end max-w-[65%]">
                      <div className="px-4 py-3 rounded-2xl rounded-tr-sm bg-emerald-600/80">
                        <div className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/80 animate-bounce [animation-delay:-0.3s]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-white/80 animate-bounce [animation-delay:-0.15s]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-white/80 animate-bounce" />
                        </div>
                      </div>
                      <p className="text-[10px] text-white/25 mt-1.5 px-1">
                        <span className="text-emerald-500/60 mr-1">AI ·</span>
                        typing...
                      </p>
                    </div>
                  </div>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="px-6 py-4 border-t border-white/[0.06]" style={{ background: "#141414" }}>
              {attachedFile && (
                <div className="mb-2 flex items-center gap-2 bg-white/[0.06] border border-white/[0.06] rounded-lg px-3 py-2 max-w-md">
                  {attachedPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachedPreview} alt="preview" className="w-10 h-10 rounded object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-white/10 flex items-center justify-center text-white/60">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/80 truncate">{attachedFile.name}</p>
                    <p className="text-[10px] text-white/40">{(attachedFile.size / 1024).toFixed(1)} KB · {attachedFile.type || "unknown"}</p>
                  </div>
                  <button
                    onClick={clearAttachment}
                    className="text-white/40 hover:text-white/80"
                    aria-label="Remove attachment"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,audio/*,video/*,application/pdf"
                onChange={onPickFile}
                className="hidden"
              />
              <div className="flex items-end gap-3 bg-white/[0.06] rounded-xl px-4 py-2.5 border border-white/[0.06] focus-within:border-emerald-500/40 transition-colors">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-white/40 hover:text-white/80 transition-colors flex-shrink-0 mb-1"
                  aria-label="Attach file"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    const el = e.target;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={attachedFile ? "Add a caption..." : "Type a message..."}
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-white/90 placeholder:text-white/25 focus:outline-none resize-none max-h-40 py-1 leading-relaxed"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || (!input.trim() && !attachedFile)}
                  className="w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 flex items-center justify-center flex-shrink-0"
                  aria-label="Send"
                >
                  {sending ? (
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
