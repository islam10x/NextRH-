import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import api from '@/services/api';
import { ChatMessage, ChatSearchResult } from '@/types';
import { Send, Bot, User, Sparkles, Loader2, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

const suggestedQueries = [
  "Who has AWS certification and 5+ years experience?",
  "Find Java developers available for bid",
  "List employees with Kubernetes skills",
];

const MAX_MESSAGES = 50;

type RagChatResponse = {
  answer?: string | null;
  results?: ChatSearchResult[];
  context?: { content: string; metadata: Record<string, unknown> }[];
};

type RagStreamEvent =
  | { type: 'context'; data?: { content: string; metadata: Record<string, unknown> }[] }
  | { type: 'token'; data?: string }
  | { type: 'replace'; data?: string }
  | { type: 'done' };

const numberedListItemPattern = /^\d+\.\s+/;
const bulletListItemPattern = /^[-*]\s+/;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const maybeErr = err as { name?: string; message?: string };
  return maybeErr.name === 'AbortError' || maybeErr.message === 'The user aborted a request.';
}

function normalizeAssistantText(content: string): string {
  if (!content) return '';
  let normalized = content.replace(/\r\n/g, '\n').trim();
  // If the model returns numbered items inline, force one item per line.
  normalized = normalized.replace(/\s+(\d+\.\s+\*\*)/g, '\n$1');
  return normalized;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, idx) => {
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (!boldMatch) return <React.Fragment key={idx}>{part}</React.Fragment>;
    return (
      <strong key={idx} className="font-semibold text-primary">
        {boldMatch[1]}
      </strong>
    );
  });
}

const AssistantMessageBody: React.FC<{ content: string }> = ({ content }) => {
  const normalized = normalizeAssistantText(content);
  if (!normalized) {
    return <p className="text-sm text-muted-foreground">Thinking...</p>;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    if (numberedListItemPattern.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && numberedListItemPattern.test(lines[i])) {
        items.push(lines[i].replace(numberedListItemPattern, '').trim());
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="list-decimal pl-5 space-y-1 text-sm leading-6">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (bulletListItemPattern.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && bulletListItemPattern.test(lines[i])) {
        items.push(lines[i].replace(bulletListItemPattern, '').trim());
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="list-disc pl-5 space-y-1 text-sm leading-6">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    blocks.push(
      <p key={`p-${key++}`} className="text-sm leading-6 whitespace-pre-wrap">
        {renderInlineMarkdown(lines[i])}
      </p>,
    );
    i += 1;
  }

  return <div className="space-y-2">{blocks}</div>;
};

const AIChatPage: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);

  const sessionId = useMemo(() => {
    const key = 'rag_session_id';
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(key, generated);
    return generated;
  }, []);

  const chatStorageKey = useMemo(() => `rag_chat_history_${sessionId}`, [sessionId]);

  useEffect(() => {
    const raw = sessionStorage.getItem(chatStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setMessages(parsed as ChatMessage[]);
      }
    } catch {
      // Ignore corrupted storage entries
    }
  }, [chatStorageKey]);

  useEffect(() => {
    sessionStorage.setItem(chatStorageKey, JSON.stringify(messages));
  }, [chatStorageKey, messages]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages, isLoading]);

  useEffect(() => {
    return () => {
      if (streamAbortControllerRef.current) {
        streamAbortControllerRef.current.abort();
        streamAbortControllerRef.current = null;
      }
    };
  }, []);

  const handleSend = async (query: string) => {
    if (!query.trim() || isLoading) return;
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: query,
      timestamp: new Date().toISOString(),
    };
    const assistantMessageId = `${Date.now()}-assistant`;
    const assistantTimestamp = new Date().toISOString();

    const setAssistantMessage = (content: string, results?: ChatSearchResult[]) => {
      setMessages((prev) =>
        prev
          .map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content,
                  ...(results ? { results } : {}),
                }
              : msg,
          )
          .slice(-MAX_MESSAGES),
      );
    };

    setMessages((prev) =>
      [
        ...prev,
        userMsg,
        { id: assistantMessageId, role: 'assistant', content: '', timestamp: assistantTimestamp },
      ].slice(-MAX_MESSAGES),
    );
    setInput('');
    setIsLoading(true);
    let rendered = '';

    if (streamAbortControllerRef.current) {
      streamAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    streamAbortControllerRef.current = abortController;

    try {
      const baseUrl = String(api.defaults.baseURL || '').replace(/\/$/, '');
      const token = sessionStorage.getItem('access_token');
      const tabSessionId = sessionStorage.getItem('session_id');
      const streamResponse = await fetch(`${baseUrl}/rag/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(tabSessionId ? { 'x-session-id': tabSessionId } : {}),
        },
        body: JSON.stringify({
          message: query,
          session_id: sessionId,
        }),
        signal: abortController.signal,
      });

      if (!streamResponse.ok || !streamResponse.body) {
        throw new Error(`Streaming request failed (${streamResponse.status})`);
      }

      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) continue;

          let event: RagStreamEvent | null = null;
          try {
            event = JSON.parse(line) as RagStreamEvent;
          } catch {
            continue;
          }
          if (!event) continue;

          if (event.type === 'token' && typeof event.data === 'string') {
            rendered += event.data;
            setAssistantMessage(rendered);
            continue;
          }

          if (event.type === 'replace' && typeof event.data === 'string') {
            rendered = event.data;
            setAssistantMessage(rendered);
            continue;
          }

          if (event.type === 'done') {
            streamDone = true;
            break;
          }
        }
      }

      if (!rendered.trim()) {
        setAssistantMessage('I could not find results for that query.');
      }
    } catch (err) {
      if (isAbortError(err)) {
        // Keep partial streamed text and stop silently when the user cancels.
        if (!rendered.trim()) {
          setAssistantMessage('Generation stopped.');
        }
        return;
      }
      console.error('RAG chat stream failed, falling back to non-streaming endpoint', err);
      try {
        const response = await api.post<RagChatResponse>('/rag/chat', {
          message: query,
          session_id: sessionId,
        });
        const answer = response.data?.answer || 'I could not find results for that query.';
        setAssistantMessage(answer, response.data?.results || []);
      } catch (fallbackErr) {
        console.error('RAG chat fallback failed', fallbackErr);
        setAssistantMessage('Sorry, I could not reach the AI service. Please try again.');
      }
    } finally {
      if (streamAbortControllerRef.current === abortController) {
        streamAbortControllerRef.current = null;
      }
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    if (streamAbortControllerRef.current) {
      streamAbortControllerRef.current.abort();
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">AI Assistant</h1>
        <p className="text-muted-foreground">Search for employees using natural language</p>
      </div>

      <Card className="flex h-[72vh] min-h-[480px] max-h-[860px] flex-col overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg"><Sparkles className="h-5 w-5 text-primary" />CV Search Assistant</CardTitle>
        </CardHeader>
        <CardContent ref={messagesViewportRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <Bot className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground mb-4">Ask me to find employees by skills, certifications, or experience.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestedQueries.map((q, i) => (
                  <Button key={i} variant="outline" size="sm" onClick={() => handleSend(q)} disabled={isLoading}>{q}</Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={cn("flex gap-3", msg.role === 'user' && "flex-row-reverse")}>
              <Avatar className="h-8 w-8">
                <AvatarFallback className={msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}>
                  {msg.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </AvatarFallback>
              </Avatar>
              <div className={cn("max-w-[80%] rounded-lg p-3", msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                {msg.role === 'assistant' ? (
                  <AssistantMessageBody content={msg.content} />
                ) : (
                  <p className="text-sm">{msg.content}</p>
                )}
                {msg.results && msg.results.length > 0 && (
                  <div className="mt-3 space-y-3">
                    {msg.results.map((result, idx) => (
                      <div key={`${result.name}-${idx}`} className="rounded-lg border border-border/60 bg-background/60 p-3 text-foreground">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-sm break-words">{result.name}</p>
                            {result.role && (
                              <p className="text-xs text-muted-foreground">{result.role}</p>
                            )}
                          </div>
                          {typeof result.experienceYears === 'number' && (
                            <span className="text-xs text-muted-foreground">{result.experienceYears}y exp</span>
                          )}
                        </div>
                        {result.companies && result.companies.length > 0 && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Companies: {result.companies.join(', ')}
                          </p>
                        )}
                        {result.skills && result.skills.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs text-muted-foreground">Skills</p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {result.skills.map((skill) => (
                                <Badge key={skill} variant="secondary" className="text-xs">
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {result.certifications && result.certifications.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs text-muted-foreground">Certifications</p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {result.certifications.map((cert) => (
                                <Badge key={cert} variant="outline" className="text-xs">
                                  {cert}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {result.projects && result.projects.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs text-muted-foreground">Projects</p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {result.projects.map((project) => (
                                <Badge key={project} variant="outline" className="text-xs">
                                  {project}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-3">
              <Avatar className="h-8 w-8"><AvatarFallback className="bg-accent text-accent-foreground"><Bot className="h-4 w-4" /></AvatarFallback></Avatar>
              <div className="bg-muted rounded-lg p-3"><Loader2 className="h-4 w-4 animate-spin" /></div>
            </div>
          )}
        </CardContent>
        <div className="p-4 border-t">
          <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="flex gap-2">
            <Input
              placeholder="Ask about employees..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isLoading}
              maxLength={2000}
            />
            {isLoading ? (
              <Button type="button" variant="destructive" onClick={handleCancel}>
                <Square className="h-4 w-4" />
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={!input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            )}
          </form>
          {input.length > 1800 && (
            <p className={cn(
              "text-xs mt-1 text-right",
              input.length >= 2000 ? "text-destructive font-medium" : "text-muted-foreground"
            )}>
              {input.length} / 2000
            </p>
          )}
        </div>
      </Card>
    </div>
  );
};

export default AIChatPage;
