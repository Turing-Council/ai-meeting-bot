import { spawn } from 'node:child_process';

/**
 * ffmpeg arguments that mix per-speaker Ogg Opus tracks into one stereo Ogg Opus file.
 * Tracks are already time-aligned (all start at the meeting start), so a plain amix works.
 * normalize=0 keeps each voice at its original level; the limiter prevents clipping when
 * several people talk at once.
 */
export function buildMixdownArgs(inputs: readonly string[], output: string, bitrateKbps = 64): string[] {
  if (inputs.length === 0) throw new Error('buildMixdownArgs: no input tracks');

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of inputs) args.push('-i', input);

  if (inputs.length > 1) {
    args.push('-filter_complex', `amix=inputs=${inputs.length}:duration=longest:normalize=0,alimiter=limit=0.95`);
  }
  args.push('-ac', '2', '-c:a', 'libopus', '-b:a', `${bitrateKbps}k`, '-application', 'voip', output);
  return args;
}

/**
 * Runs ffmpeg and resolves with its full stderr (where filters like silencedetect report).
 * Rejects with the tail of stderr if it fails.
 */
export function runFfmpeg(ffmpegPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', (error) => reject(new Error(`Could not start ffmpeg (${ffmpegPath}): ${error.message}`)));
    child.once('close', (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-4000).trim()}`));
    });
  });
}

export async function mixdown(
  ffmpegPath: string,
  inputs: readonly string[],
  output: string,
): Promise<void> {
  await runFfmpeg(ffmpegPath, buildMixdownArgs(inputs, output));
}
