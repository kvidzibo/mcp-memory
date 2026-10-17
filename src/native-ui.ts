import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MemoryStore, hash } from './store.js';

export const MEMORY_URI = 'memory://overview';
export const UI_MIME = 'application/vnd.mcp-native-ui+json';
const actionSchema = z.object({
  method: z.literal('native-ui/action'),
  params: z.object({
    uri: z.literal(MEMORY_URI), revision: z.string().min(1).max(256),
    action: z.literal('details'), _meta: z.record(z.string(),z.unknown()).optional(),
  }).strict(),
});

/** Optional private native UI protocol; ordinary MCP clients can ignore it. */
export function registerNativeUI(server: McpServer, store: MemoryStore): void {
  const view = () => {
    const counts = store.counts();
    const options = store.options;
    // JSON-escape paths so whitespace/control characters cannot disguise the scope.
    const body = [
      `Project: ${JSON.stringify(options.project)}`,
      `Active memories: ${counts.project} project | ${counts.global ?? 'disabled'} global`,
      `Project writes: ${options.allowWrite ? 'enabled' : 'disabled'}`,
      `Global writes: ${options.allowWrite && options.readGlobal && options.allowGlobalWrite ? 'enabled' : 'disabled'}`,
      '',
      'Counts exclude archived lessons and other projects.',
      'External changes appear on the next tool call or app refresh (Ctrl+R).',
    ].join('\n');
    return {
      version: 1 as const, title: 'Memory', revision: hash(body), state: {}, body,
      controls: [{ id: 'details',kind: 'action' as const,label: 'Show memory details' }],
      footer: [{ text: `🧠 ${counts.project}|${counts.global ?? '-'}`,action: 'details' }],
    };
  };
  server.server.registerCapabilities({ experimental: { 'native-ui-v1': {} } });
  server.registerResource('Memory',MEMORY_URI,{ mimeType: UI_MIME,description: 'Launch-bound active project/global memory counts and permissions; no lesson content.' },async uri => ({
    contents: [{ uri: uri.href,mimeType: UI_MIME,text: JSON.stringify(view()) }],
  }));
  server.server.setRequestHandler(actionSchema,async request => {
    if (request.params.uri !== MEMORY_URI || request.params.action !== 'details') throw new McpError(ErrorCode.InvalidParams,'Unknown memory action');
    // Read-only details deliberately use fresh data, even if displayed counts changed.
    const current = view();
    return { view: current,preview: current.body };
  });
}
