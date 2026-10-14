import { bootstrap } from '../bootstrap.js';
import type { Config } from '../config.js';

export async function chat(
  prompt: string,
  config: Config,
  stream: boolean,
  signal: AbortSignal,
) {
  const { provider, request } = bootstrap(config, signal);
  const input = {
    ...request,
    messages: [{ role: 'user' as const, content: prompt }],
  };
  if (stream) {
    for await (const event of provider.stream(input)) {
      if (event.type === 'text.delta') process.stdout.write(event.text);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(`${(await provider.generate(input)).text}\n`);
  }
}
