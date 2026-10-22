import { hostInDomains, type Logger, type PlatformDefinition } from '@ugc/core';
import type { GenerationJob, GenerationStore } from './generation-store.js';
import { MAX_VIDEO_BYTES, type VideoLibrary } from './library.js';
import type { PocProfile } from './profiles.js';
import { setDownloadHandler } from './sessions.js';

/**
 * The one exception to "no downloads": a video the owner downloads by hand in
 * an Account Bundle's Google Flow window is saved, without a dialog, into that
 * bundle's library. Only from the platform's allowed source domains, only
 * MP4, only under the size cap; the file must pass the MP4 check after it
 * finishes or it is deleted. Each download is recorded as a non-secret
 * 'manual_download' job (size and hash only). Everything else stays blocked.
 */

/** Hosts a Flow video download may come from, besides the platform's own domains (Google serves media from these). */
const GOOGLE_MEDIA_DOMAINS = ['googleusercontent.com', 'googleapis.com', 'gstatic.com'];

function sourceAllowed(url: string, domains: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    // A blob: URL carries the page origin that created it, e.g. blob:https://flow.google.com/<uuid>.
    const effective = parsed.protocol === 'blob:' ? new URL(parsed.pathname) : parsed;
    return effective.protocol === 'https:' && hostInDomains(effective.hostname, domains);
  } catch {
    return false;
  }
}

export function attachFlowDownloads(
  profile: PocProfile,
  platform: PlatformDefinition,
  ses: Electron.Session,
  deps: {
    library: VideoLibrary;
    jobs: GenerationStore;
    log: Logger;
    synthetic: boolean;
    /** The prompt the owner took to Flow by hand, if any: the download is linked to it (T1). */
    claimPrompt?: (bundleId: string) => string | null;
    onEnded?: (job: GenerationJob) => void;
  },
): void {
  if (!profile.bundleId || platform.id !== 'google-flow') return;
  const bundleId = profile.bundleId;
  const domains = deps.synthetic ? platform.navigationDomains : [...platform.navigationDomains, ...GOOGLE_MEDIA_DOMAINS];
  setDownloadHandler(ses, (item) => {
    const isMp4 = item.getMimeType() === 'video/mp4' || item.getFilename().toLowerCase().endsWith('.mp4');
    if (!sourceAllowed(item.getURL(), domains) || !isMp4 || item.getTotalBytes() > MAX_VIDEO_BYTES) {
      deps.log.warn('download_rejected', { bundleId, reason: !isMp4 ? 'not_mp4' : item.getTotalBytes() > MAX_VIDEO_BYTES ? 'too_large' : 'source_not_allowed' });
      return false;
    }
    const job = deps.jobs.create({ bundleId, source: 'manual_download', providerId: 'google-flow-manual', settings: null, promptItemId: deps.claimPrompt?.(bundleId) ?? null });
    deps.jobs.transition(job.id, 'running', { code: 'download_started' });
    const part = deps.library.partPath(bundleId, job.id);
    item.setSavePath(part);
    item.on('updated', () => {
      if (item.getReceivedBytes() > MAX_VIDEO_BYTES) item.cancel();
    });
    item.once('done', (_event, state) => {
      // An interrupted or cancelled download is deleted, never kept as a partial video.
      if (state !== 'completed') deps.library.discard(part);
      const stored = state === 'completed' ? deps.library.finalize(part) : null;
      let ended: GenerationJob;
      if (stored) {
        ended = deps.jobs.transition(job.id, 'completed', { video: stored, code: 'manual_download' });
        deps.log.info('manual_download_saved', { bundleId, jobId: job.id, bytes: stored.bytes });
      } else {
        ended = deps.jobs.transition(job.id, 'failed', { errorCode: state === 'completed' ? 'output_invalid' : 'cancelled' });
        deps.log.warn('manual_download_failed', { bundleId, jobId: job.id, state });
      }
      try {
        deps.onEnded?.(ended);
      } catch (err) {
        deps.log.error('manual_download_hook_error', { bundleId, jobId: job.id, err });
      }
    });
    deps.log.info('manual_download_started', { bundleId, jobId: job.id });
    return true;
  });
}
