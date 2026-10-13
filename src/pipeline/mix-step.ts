import { rename, stat } from 'node:fs/promises';
import { mixdown } from '../recorder/mixdown.js';
import { MIXED_FILE } from './files.js';
import type { PipelineStep, StepContext } from './runner.js';

/** Mixes the per-speaker tracks into `mixed.ogg` for playback (and, in M3, the Notion upload). */
export function mixStep({ ffmpegPath }: { ffmpegPath: string }): PipelineStep {
  return {
    name: 'mix',
    async run({ manifest, logger, resolve }: StepContext) {
      const inputs: string[] = [];
      for (const track of manifest.tracks) {
        const file = resolve(track.file);
        const size = await stat(file).then((s) => s.size, () => 0);
        if (size > 0) inputs.push(file);
        else logger.warn('Skipping missing or empty track', { file: track.file });
      }
      if (inputs.length === 0) throw new Error('No audio to mix: every track file is missing or empty');

      // Write next to the final file and rename, so a crash never leaves a half-written mix.
      const tmp = resolve('mixed.tmp.ogg');
      await mixdown(ffmpegPath, inputs, tmp);
      await rename(tmp, resolve(MIXED_FILE));
      manifest.mixedFile = MIXED_FILE;
    },
  };
}
