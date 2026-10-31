/**
 * neu-meet patch: the video upload against a local server. A stalled meeting-api fails the upload after the
 * idle timeout (it runs while the bot is still in the call), and the upload never deletes the file.
 * No ffmpeg, no meeting-api. Run: npx tsx src/video-recording.test.ts
 */
import * as fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { VideoRecordingService } from './video-recording';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

/** A server that reads the body and answers with status, or never answers (null). */
async function server(status: number | null) {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { if (status !== null) res.writeHead(status).end('ok'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/upload` };
}

(async () => {
  const video = new VideoRecordingService(0, `test-${process.pid}`);
  fs.writeFileSync(video.getFilePath(), Buffer.alloc(1024));
  try {
    let s = await server(null);
    const t0 = Date.now();
    const err = await video.upload(s.url, 'x', 200).then(() => null, (e: Error) => e);
    s.srv.closeAllConnections(); s.srv.close();
    check('stalled server: rejects after the idle timeout', !!err && /stalled/.test(err.message) && Date.now() - t0 < 5_000, String(err));
    check('stalled server: the file is kept', fs.existsSync(video.getFilePath()));
    s = await server(503);
    check('5xx: rejects, file kept', await video.upload(s.url, 'x', 200).then(() => false, () => true) && fs.existsSync(video.getFilePath()));
    s.srv.close();
    s = await server(200);
    check('2xx: resolves', await video.upload(s.url, 'x', 200).then(() => true, () => false));
    s.srv.close();
  } finally {
    await video.cleanup();
  }
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nvideo-recording upload: all checks passed');
})();
