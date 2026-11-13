import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';
import { chmodSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main(): Promise<void> {
  const apiIdStr = process.env.API_ID;
  const apiHash = process.env.API_HASH;

  if (!apiIdStr) {
    throw new Error('Missing required environment variable: API_ID');
  }
  if (!apiHash) {
    throw new Error('Missing required environment variable: API_HASH');
  }

  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) {
    throw new Error(`API_ID must be a valid integer, got: ${apiIdStr}`);
  }

  const session = new StringSession('');

  const client = new TelegramClient(session, apiId, apiHash, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  await client.start({
    phoneNumber: async () => prompt('Phone number (+countrycode): '),
    password: async () => prompt('2FA password (or leave empty): '),
    phoneCode: async () => prompt('Verification code: '),
    onError: (err: Error) => {
      console.error('Auth error:', err.message);
      throw err;
    },
  });

  console.log('\nAuthentication successful!');

  // The session string is a full login to the Telegram account. Write it to a
  // 0600 file instead of echoing it to the terminal (scrollback, recordings,
  // CI logs). Never print it to stdout.
  const sessionPath = resolve(process.env['SESSION_OUT'] ?? 'gramjs-session.txt');
  writeFileSync(sessionPath, String(client.session.save()) + '\n', { mode: 0o600 });
  chmodSync(sessionPath, 0o600); // mode only applies on creation — tighten existing files too
  console.log(`Session string written to ${sessionPath} (mode 0600).`);
  console.log('Set it as the GRAMJS_SESSION secret (fly secrets set / wrangler), then delete the file.');

  await client.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
