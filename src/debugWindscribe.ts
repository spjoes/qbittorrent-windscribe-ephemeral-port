import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {KeyvFile} from 'keyv-file';
import {WindscribeClient} from './WindscribeClient.js';

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const cacheDir = envString('CACHE_DIR') ?? './cache';
fs.mkdirSync(cacheDir, {recursive: true});

const windscribe = new WindscribeClient(
  envString('WINDSCRIBE_USERNAME'),
  envString('WINDSCRIBE_PASSWORD'),
  envString('WINDSCRIBE_AUTH_HASH'),
  new KeyvFile({
    filename: path.join(cacheDir, 'cache.json'),
  }),
  envString('WINDSCRIBE_TOTP_SECRET'),
  parseInt(envString('WINDSCRIBE_EPHEMERAL_INTERNAL_PORT') ?? '0'),
);

try {
  const status = await windscribe.debugStatus();
  const expires = status.epfExpires == 0
    ? null
    : new Date((status.epfExpires + 86400 * 7) * 1000);

  console.log('Windscribe debug check succeeded');
  console.log(`CSRF token found: ${status.csrfTokenFound}`);
  console.log(`Current ephemeral ports: ${status.ports.length > 0 ? status.ports.join(' -> ') : 'none'}`);
  console.log(`Current ephemeral port expires: ${expires ? expires.toISOString() : 'none'}`);
} catch (error) {
  console.error('Windscribe debug check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
