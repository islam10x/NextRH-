import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import ReactMarkdown from 'react-markdown';
import { ChatMessage, ChatSearchResult } from '@/types';
import { Send, Bot, User, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const suggestedQueries = [
  "Who has AWS certification and 5+ years experience?",
  "Find Java developers available for bid",
  "List employees with Kubernetes skills",
];

const MAX_MESSAGES = 50;

const AIChatPage: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async (query: string) => {
    if (!query.trim() || isLoading) return;
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: query,
      timestamp: new Date().toISOString(),
    };
    const aiMsgId = (Date.now() + 1).toString();

    setMessages(prev => [...prev, userMsg].slice(-MAX_MESSAGES));
    setInput('');
    setIsLoading(true);

    // Create a placeholder assistant message that we'll update as tokens stream in
    const placeholderMsg: ChatMessage = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      results: undefined,
    };
    setMessages(prev => [...prev, placeholderMsg].slice(-MAX_MESSAGES));

    try {
      const token = sessionStorage.getItem('access_token');
      const response = await fetch(`${API_BASE}/rag/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: query, session_id: sessionId }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';
      let results: ChatSearchResult[] | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed);

            if (event.type === 'results') {
              // Cards arrive first
              results = Array.isArray(event.data) ? event.data : [];
              setMessages(prev =>
                prev.map(m =>
                  m.id === aiMsgId ? { ...m, results } : m
                )
              );
            } else if (event.type === 'token') {
              accumulatedContent += event.data || '';
              const snapshot = accumulatedContent;
              setMessages(prev =>
                prev.map(m =>
                  m.id === aiMsgId ? { ...m, content: snapshot } : m
                )
              );
            } else if (event.type === 'replace') {
              accumulatedContent = event.data || '';
              const snapshot = accumulatedContent;
              setMessages(prev =>
                prev.map(m =>
                  m.id === aiMsgId ? { ...m, content: snapshot } : m
                )
              );
            }
            // 'done' — nothing extra needed
          } catch {
            // skip malformed lines
          }
        }
      }

      // If no content came through at all
      if (!accumulatedContent) {
        setMessages(prev =>
          prev.map(m =>
            m.id === aiMsgId
              ? { ...m, content: 'I could not find results for that query.' }
              : m
          )
        );
      }
    } catch (err) {
      console.error('RAG chat stream failed', err);
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMsgId
            ? { ...m, content: 'Sorry, I could not reach the AI service. Please try again.' }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, sessionId]);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">AI Assistant</h1>
        <p className="text-muted-foreground">Search for employees using natural language</p>
      </div>

      <Card className="min-h-[500px] flex flex-col">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            CV Search Assistant
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-4 space-y-4 overflow-y-auto max-h-[60vh]">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <Bot className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground mb-4">
                Ask me to find employees by skills, certifications, or experience.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestedQueries.map((q, i) => (
                  <Button key={i} variant="outline" size="sm" onClick={() => handleSend(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn('flex gap-3', msg.role === 'user' && 'flex-row-reverse')}
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback
                  className={
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent text-accent-foreground'
                  }
                >
                  {msg.role === 'user' ? (
                    <User className="h-4 w-4" />
                  ) : (
                    <Bot className="h-4 w-4" />
                  )}
                </AvatarFallback>
              </Avatar>
              <div
                className={cn(
                  'max-w-[80%] rounded-lg p-3',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                )}
              >
                {/* Result cards appear FIRST (above the text) */}
                {msg.results && msg.results.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {msg.results.map((result, idx) => (
                      <div
                        key={`${result.name}-${idx}`}
                        className="rounded-lg border border-border/60 bg-background/60 p-3 text-foreground"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-sm break-words">
                              {result.name}
                            </p>
                            {result.role && (
                              <p className="text-xs text-muted-foreground">
                                {result.role}
                              </p>
                            )}
                          </div>
                          {typeof result.experienceYears === 'number' && (
                            <span className="text-xs text-muted-foreground">
                              {result.experienceYears}y exp
                            </span>
                          )}
                        </div>
                        {result.companies && result.companies.length > 0 && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Companies: {result.companies.join(', ')}
                          </p>
                        )}
                        {result.skills && result.skills.length > 0 && (
                          <div className="mt-2">
                            <div className="flex flex-wrap gap-1 mt-1">
                              {result.skills.map((skill) => (
                                <Badge
                                  key={skill}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {result.certifications &&
                          result.certifications.length > 0 && (
                            <div className="mt-2">
                              <div className="flex flex-wrap gap-1 mt-1">
                                {result.certifications.map((cert) => (
                                  <Badge
                                    key={cert}
                                    variant="outline"
                                    className="text-xs"
                                  >
                                    {cert}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        {result.projects && result.projects.length > 0 && (
                          <div className="mt-2">
                            <div className="flex flex-wrap gap-1 mt-1">
                              {result.projects.map((project) => (
                                <Badge
                                  key={project}
                                  variant="outline"
                                  className="text-xs"
                                >
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

                {/* Streaming text with Markdown rendering */}
                {msg.role === 'assistant' ? (
                  <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1">
                    {msg.content ? (
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    ) : isLoading && msg.id === messages[messages.length - 1]?.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm">{msg.content}</p>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </CardContent>
        <div className="p-4 border-t">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="flex gap-2"
          >
            <Input
              placeholder="Ask about employees..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isLoading}
            />
            <Button type="submit" disabled={isLoading || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
};

export default AIChatPage;
