import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { searchEmployees } from '@/data/mockData';
import { ChatMessage, Employee } from '@/types';
import { Send, Bot, User, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const suggestedQueries = [
  "Who has AWS certification and 5+ years experience?",
  "Find Java developers available for bid",
  "List employees with Kubernetes skills",
];

const AIChatPage: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = async (query: string) => {
    if (!query.trim()) return;
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: query, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    await new Promise(r => setTimeout(r, 1500));
    const results = searchEmployees(query);
    const aiMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: `I found ${results.length} employee(s) matching your criteria.`,
      timestamp: new Date().toISOString(),
      results: results.slice(0, 5),
    };
    setMessages(prev => [...prev, aiMsg]);
    setIsLoading(false);
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
        <CardContent className="flex-1 p-4 space-y-4 overflow-y-auto">
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
                  <div className="mt-3 space-y-2">
                    {msg.results.map((emp) => (
                      <div key={emp.id} className="p-2 rounded bg-background/50 text-foreground">
                        <p className="font-medium text-sm">{emp.name}</p>
                        <p className="text-xs text-muted-foreground">{emp.title} • {emp.yearsOfExperience}y</p>
                        <div className="flex gap-1 mt-1">{emp.skills.slice(0, 3).map(s => <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>)}</div>
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
            <Input placeholder="Ask about employees..." value={input} onChange={(e) => setInput(e.target.value)} disabled={isLoading} />
            <Button type="submit" disabled={isLoading || !input.trim()}><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      </Card>
    </div>
  );
};

export default AIChatPage;
