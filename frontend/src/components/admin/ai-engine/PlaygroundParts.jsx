import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Clock, DollarSign } from 'lucide-react';
import { aiEngine } from '@/lib/aiEngine';

// The pieces of PlaygroundTab: the two input forms, the response card's
// contents, the history list, and the call itself.

export function fmtCost(usd) {
  if (!usd || usd < 0.000001) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** What is still missing before Send can run, or '' when nothing is. */
export function missingInputMessage({ mode, provider, userPrompt, server, tool }) {
  if (mode === 'ai' && (!provider || !userPrompt)) return 'Pick a provider and write a prompt';
  if (mode === 'mcp' && (!server || !tool)) return 'Pick a server and tool';
  return '';
}

function parseToolArgs(toolArgs) {
  try {
    return JSON.parse(toolArgs);
  } catch {
    /* ignore */
    return {};
  }
}

/** Sends the prompt or tool call and returns the history entry for it. */
export async function runPlaygroundCall(input) {
  const { mode, provider, model, userPrompt, systemPrompt, server, tool, toolArgs } = input;
  const t0 = Date.now();
  if (mode === 'ai') {
    const result = await aiEngine.chat(
      provider,
      model,
      userPrompt,
      systemPrompt,
      'admin_playground'
    );
    return {
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
  }
  const result = await aiEngine.mcpTool(server, tool, parseToolArgs(toolArgs));
  return {
    id: Date.now(),
    mode,
    server,
    tool,
    text: result.result || JSON.stringify(result),
    latencyMs: Date.now() - t0,
  };
}

/** A small labelled select, used for provider, model, server and tool. */
function PickerSelect({ label, value, onChange, placeholder, children }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs mt-1">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

function PromptArea({ label, rows, placeholder, value, onChange, className }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Textarea
        className={className}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function AiPromptInputs({
  providers,
  enabledProviders,
  selectedProvider,
  provider,
  setProvider,
  model,
  setModel,
  systemPrompt,
  setSystemPrompt,
  userPrompt,
  setUserPrompt,
}) {
  return (
    <>
      {enabledProviders.length === 0 ? (
        <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
          Enable and test at least one AI provider first.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <PickerSelect
            label="Provider"
            value={provider}
            onChange={(nextProvider) => {
              setProvider(nextProvider);
              const next = providers.find((p) => p.id === nextProvider);
              setModel(next?.models?.[0] || '');
            }}
            placeholder="Pick provider"
          >
            {enabledProviders.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {p.icon} {p.name}
              </SelectItem>
            ))}
          </PickerSelect>
          <PickerSelect label="Model" value={model} onChange={setModel} placeholder="Model">
            {(selectedProvider?.models || []).map((m) => (
              <SelectItem key={m} value={m} className="text-xs">
                {m}
              </SelectItem>
            ))}
          </PickerSelect>
        </div>
      )}

      <PromptArea
        label="System Prompt (optional)"
        className="text-xs mt-1 resize-none"
        rows={2}
        placeholder="You are a helpful assistant..."
        value={systemPrompt}
        onChange={setSystemPrompt}
      />
      <PromptArea
        label="User Message *"
        className="text-xs mt-1 resize-none"
        rows={4}
        placeholder="What would you like to ask?"
        value={userPrompt}
        onChange={setUserPrompt}
      />
    </>
  );
}

export function McpToolInputs({
  servers,
  enabledServers,
  selectedServer,
  server,
  setServer,
  tool,
  setTool,
  toolArgs,
  setToolArgs,
}) {
  return (
    <>
      {enabledServers.length === 0 ? (
        <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
          Enable a server and sync its tools first.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <PickerSelect
            label="Server"
            value={server}
            onChange={(nextServer) => {
              setServer(nextServer);
              const next = servers.find((s) => s.id === nextServer);
              setTool(next?.tools?.[0]?.name || '');
            }}
            placeholder="Pick server"
          >
            {enabledServers.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.name}
              </SelectItem>
            ))}
          </PickerSelect>
          <PickerSelect label="Tool" value={tool} onChange={setTool} placeholder="Tool">
            {(selectedServer?.tools || []).map((t) => (
              <SelectItem key={t.name} value={t.name} className="text-xs font-mono">
                {t.name}
              </SelectItem>
            ))}
          </PickerSelect>
        </div>
      )}
      <PromptArea
        label="Arguments (JSON)"
        className="text-xs mt-1 font-mono resize-none"
        rows={4}
        placeholder='{"query": "latest cloud news"}'
        value={toolArgs}
        onChange={setToolArgs}
      />
    </>
  );
}

/** Time, cost and tokens of the shown response, beside the card's title. */
export function ResponseMeta({ response }) {
  return (
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
        <span>{fmtTokens(response.promptTokens + response.completionTokens)} tokens</span>
      )}
    </span>
  );
}

export function ResponseBody({ sending, response }) {
  if (sending) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Waiting for response…
      </div>
    );
  }
  if (!response) {
    return <p className="text-xs text-slate-400 italic">Response will appear here.</p>;
  }
  return (
    <div className="text-xs whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto font-mono bg-slate-50 dark:bg-slate-900 p-3 rounded border">
      {response.text}
    </div>
  );
}

export function HistoryList({ history, onPick }) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Recent calls this session</h3>
      <div className="space-y-1">
        {history.map((h) => (
          <button
            key={h.id}
            className="w-full text-left px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded text-xs hover:bg-slate-100 transition-colors"
            onClick={() => onPick(h)}
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
  );
}
