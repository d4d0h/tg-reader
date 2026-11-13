import { describe, expect, it } from 'vitest';
import { dispatchMcpTool } from './index';
import type { Env, RoleRow, TokenContext } from './types';

// The dispatch-entry guard runs before any tool implementation, so no
// database is touched for the denied cases and env can be a stub.
const env = {} as unknown as Env;

const scopedCtx: TokenContext = {
  token_id: 42n,
  role: {
    id: 1n,
    name: 'reader',
    read_mode: 'whitelist',
    read_labels: ['vip'],
    read_chat_ids: ['123'],
    can_send: 0,
    can_edit: 0,
    can_delete: 0,
    can_forward: 0,
    write_chat_types: null,
    write_labels: null,
    write_chat_ids: null,
  } as RoleRow,
};

describe('master-only MCP tools (#99, #100)', () => {
  it.each(['address_book', 'contacts', 'stats', 'outbox_status'])(
    'a scoped agent token is denied %s at dispatch entry',
    async (name) => {
      const result = (await dispatchMcpTool(name, {}, env, 'primary', scopedCtx)) as {
        error?: string;
      };
      expect(result.error).toBe('permission_denied');
    },
  );

  it.each(['create_token', 'create_role'])('management tools stay denied for scoped tokens', async (name) => {
    const result = (await dispatchMcpTool(name, {}, env, 'primary', scopedCtx)) as {
      error?: string;
    };
    expect(result.error).toBe('permission_denied');
  });
});
