import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Send } from 'lucide-react';
import {
  AiPromptInputs,
  HistoryList,
  McpToolInputs,
  ResponseBody,
  ResponseMeta,
  missingInputMessage,
  runPlaygroundCall,
} from './PlaygroundParts';

export default function PlaygroundTab({ providers, servers }) {
  const [mode, setMode] = useState('ai');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [server, setServer] = useState('');
  const [tool, setTool] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState(null);
  const [history, setHistory] = useState([]);
  const { toast } = useToast();

  const enabledProviders = providers.filter((p) => p.enabled && p.status !== 'unavailable');
  const enabledServers = servers.filter((s) => s.enabled && s.tools?.length > 0);

  const selectedProvider = providers.find((p) => p.id === provider);
  const selectedServer = servers.find((s) => s.id === server);

  const handleSend = async () => {
    const missing = missingInputMessage({ mode, provider, userPrompt, server, tool });
    if (missing) {
      toast({ title: missing, variant: 'destructive' });
      return;
    }

    setSending(true);
    setResponse(null);
    try {
      const entry = await runPlaygroundCall({
        mode,
        provider,
        model,
        userPrompt,
        systemPrompt,
        server,
        tool,
        toolArgs,
      });
      setResponse(entry);
      setHistory((h) => [entry, ...h.slice(0, 9)]);
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-lg">Playground</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Test any AI provider or MCP tool directly from here.
        </p>
      </div>

      <div className="flex gap-2">
        {[
          { id: 'ai', label: '🤖 AI Provider' },
          { id: 'mcp', label: '🔧 MCP Tool' },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === m.id
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{mode === 'ai' ? 'Prompt' : 'Tool Call'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {mode === 'ai' ? (
              <AiPromptInputs
                providers={providers}
                enabledProviders={enabledProviders}
                selectedProvider={selectedProvider}
                provider={provider}
                setProvider={setProvider}
                model={model}
                setModel={setModel}
                systemPrompt={systemPrompt}
                setSystemPrompt={setSystemPrompt}
                userPrompt={userPrompt}
                setUserPrompt={setUserPrompt}
              />
            ) : (
              <McpToolInputs
                servers={servers}
                enabledServers={enabledServers}
                selectedServer={selectedServer}
                server={server}
                setServer={setServer}
                tool={tool}
                setTool={setTool}
                toolArgs={toolArgs}
                setToolArgs={setToolArgs}
              />
            )}

            <Button className="w-full" onClick={handleSend} disabled={sending}>
              {sending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Send
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Response</span>
              {response && <ResponseMeta response={response} />}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponseBody sending={sending} response={response} />
          </CardContent>
        </Card>
      </div>

      {history.length > 0 && <HistoryList history={history} onPick={setResponse} />}
    </div>
  );
}
