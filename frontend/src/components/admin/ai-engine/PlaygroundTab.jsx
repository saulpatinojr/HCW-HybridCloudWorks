import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Send, Clock, DollarSign } from 'lucide-react';
import { aiEngine } from '@/lib/aiEngine';

function fmtCost(usd) {
  if (!usd || usd < 0.000001) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

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
    if (mode === 'ai' && (!provider || !userPrompt)) {
      toast({ title: 'Pick a provider and write a prompt', variant: 'destructive' });
      return;
    }
    if (mode === 'mcp' && (!server || !tool)) {
      toast({ title: 'Pick a server and tool', variant: 'destructive' });
      return;
    }

    setSending(true);
    setResponse(null);
    const t0 = Date.now();

    try {
      let result;
      if (mode === 'ai') {
        result = await aiEngine.chat(provider, model, userPrompt, systemPrompt, 'admin_playground');
        const entry = {
          id: Date.now(),
          mode,
          provider,
          model,
          prompt: userPrompt,
          text: result.text,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          estimatedCostUsd: result.estimatedCostUsd,
          latencyMs: result.latencyMs || Date.now() - t0,
        };
        setResponse(entry);
        setHistory((h) => [entry, ...h.slice(0, 9)]);
      } else {
        let args = {};
        try {
          args = JSON.parse(toolArgs);
        } catch {
          /* ignore */
        }
        result = await aiEngine.mcpTool(server, tool, args);
        const entry = {
          id: Date.now(),
          mode,
          server,
          tool,
          text: result.result || JSON.stringify(result),
          latencyMs: Date.now() - t0,
        };
        setResponse(entry);
        setHistory((h) => [entry, ...h.slice(0, 9)]);
      }
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
              <>
                {enabledProviders.length === 0 ? (
                  <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                    Enable and test at least one AI provider first.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Provider</Label>
                      <Select
                        value={provider}
                        onValueChange={(nextProvider) => {
                          setProvider(nextProvider);
                          const next = providers.find((p) => p.id === nextProvider);
                          setModel(next?.models?.[0] || '');
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Pick provider" />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledProviders.map((p) => (
                            <SelectItem key={p.id} value={p.id} className="text-xs">
                              {p.icon} {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Model</Label>
                      <Select value={model} onValueChange={setModel}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Model" />
                        </SelectTrigger>
                        <SelectContent>
                          {(selectedProvider?.models || []).map((m) => (
                            <SelectItem key={m} value={m} className="text-xs">
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs">System Prompt (optional)</Label>
                  <Textarea
                    className="text-xs mt-1 resize-none"
                    rows={2}
                    placeholder="You are a helpful assistant..."
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">User Message *</Label>
                  <Textarea
                    className="text-xs mt-1 resize-none"
                    rows={4}
                    placeholder="What would you like to ask?"
                    value={userPrompt}
                    onChange={(e) => setUserPrompt(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                {enabledServers.length === 0 ? (
                  <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                    Enable a server and sync its tools first.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Server</Label>
                      <Select
                        value={server}
                        onValueChange={(nextServer) => {
                          setServer(nextServer);
                          const next = servers.find((s) => s.id === nextServer);
                          setTool(next?.tools?.[0]?.name || '');
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Pick server" />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledServers.map((s) => (
                            <SelectItem key={s.id} value={s.id} className="text-xs">
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Tool</Label>
                      <Select value={tool} onValueChange={setTool}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Tool" />
                        </SelectTrigger>
                        <SelectContent>
                          {(selectedServer?.tools || []).map((t) => (
                            <SelectItem key={t.name} value={t.name} className="text-xs font-mono">
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div>
                  <Label className="text-xs">Arguments (JSON)</Label>
                  <Textarea
                    className="text-xs mt-1 font-mono resize-none"
                    rows={4}
                    placeholder='{"query": "latest cloud news"}'
                    value={toolArgs}
                    onChange={(e) => setToolArgs(e.target.value)}
                  />
                </div>
              </>
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
              {response && (
                <span className="flex gap-2 text-xs font-normal text-slate-500">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {response.latencyMs}ms
                  </span>
                  {response.estimatedCostUsd !== undefined && (
                    <span className="flex items-center gap-1">
                      <DollarSign className="h-3 w-3" />
                      {fmtCost(response.estimatedCostUsd)}
                    </span>
                  )}
                  {response.promptTokens > 0 && (
                    <span>
                      {fmtTokens(response.promptTokens + response.completionTokens)} tokens
                    </span>
                  )}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sending && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Waiting for response…
              </div>
            )}
            {!sending && !response && (
              <p className="text-xs text-slate-400 italic">Response will appear here.</p>
            )}
            {!sending && response && (
              <div className="text-xs whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto font-mono bg-slate-50 dark:bg-slate-900 p-3 rounded border">
                {response.text}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Recent calls this session</h3>
          <div className="space-y-1">
            {history.map((h) => (
              <button
                key={h.id}
                className="w-full text-left px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded text-xs hover:bg-slate-100 transition-colors"
                onClick={() => setResponse(h)}
              >
                <span className="font-medium">
                  {h.provider || h.server}/{h.model || h.tool}
                </span>
                <span className="text-slate-400 ml-2 truncate inline-block max-w-xs">
                  {(h.prompt || h.tool || '').slice(0, 60)}
                </span>
                <span className="text-slate-400 ml-auto float-right">{h.latencyMs}ms</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
