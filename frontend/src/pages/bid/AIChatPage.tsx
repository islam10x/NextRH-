import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import api from '@/services/api';
import { ChatMessage, ChatSearchResult } from '@/types';
import { Send, Bot, User, Sparkles, Loader2 } from 'lucide-react';
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
};

const AIChatPage: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  const handleSend = async (query: string) => {
    if (!query.trim()) return;

    const userMsgId = Date.now().toString();
    const userMsg: ChatMessage = { 
      id: userMsgId, 
      role: 'user', 
      content: query, 
      timestamp: new Date().toISOString() 
    };

    const aiMsgId = (Date.now() + 1).toString();
    const initialAiMsg: ChatMessage = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      results: [],
    };

    setMessages(prev => [...prev, userMsg, initialAiMsg].slice(-MAX_MESSAGES));
    setInput('');
    setIsLoading(true);

    try {
      const token = sessionStorage.getItem('access_token');
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      
      const response = await fetch(`${baseUrl}/rag/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: query,
          session_id: sessionId,
        }),
      });

      if (!response.ok) throw new Error(`Stream error: ${response.statusText}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
              setMessages(prev => prev.map(m => 
                m.id === aiMsgId ? { ...m, results: event.data } : m
              ));
            } else if (event.type === 'token') {
              setMessages(prev => prev.map(m => 
                m.id === aiMsgId ? { ...m, content: m.content + (event.data || '') } : m
              ));
            } else if (event.type === 'replace') {
              setMessages(prev => prev.map(m => 
                m.id === aiMsgId ? { ...m, content: event.data || '' } : m
              ));
            } else if (event.type === 'done') {
              setIsLoading(false);
            }
          } catch (e) {
            console.warn('Failed to parse stream line', trimmed, e);
          }
        }
      }
    } catch (err) {
      console.error('RAG chat stream failed', err);
      setMessages(prev => prev.map(m => 
        m.id === aiMsgId 
          ? { ...m, content: 'Sorry, I could not reach the AI service. Please try again.' } 
          : m
      ));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">AI Assistant</h1>
        <p className="text-muted-foreground">Search for employees using natural language</p>
      </div>

      <Card className="min-h-[500px] flex flex-col">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-lg"><Sparkles className="h-5 w-5 text-primary" />CV Search Assistant</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 p-4 space-y-4 overflow-y-auto" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="text-center py-12">
              <Bot className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground mb-4">Ask me to find employees by skills, certifications, or experience.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestedQueries.map((q, i) => (
                  <Button key={i} variant="outline" size="sm" onClick={() => handleSend(q)}>{q}</Button>
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
                <p className="text-sm">{msg.content}</p>
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
          {isLoading && (!messages[messages.length - 1]?.content && !messages[messages.length - 1]?.results?.length) && (
            <div className="flex gap-3">
              <Avatar className="h-8 w-8"><AvatarFallback className="bg-accent text-accent-foreground"><Bot className="h-4 w-4" /></AvatarFallback></Avatar>
              <div className="bg-muted rounded-lg p-3"><Loader2 className="h-4 w-4 animate-spin" /></div>
            </div>
          )}
        </CardContent>
        <div className="p-4 border-t">
          <form onSubmit={(e) => { e.preventDefault(); handleSend(input); }} className="flex gap-2">
            <Input placeholder="Ask about employees..." value={input} onChange={(e) => setInput(e.target.value)} disabled={isLoading} />
            <Button type="submit" disabled={isLoading || !input.trim()}><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      </Card>
    </div>
  );
};

export default AIChatPage;
