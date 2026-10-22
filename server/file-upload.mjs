import { randomBytes, createHash } from 'node:crypto';
import { extractFileBytes, fileErrorCode } from './core.mjs';

const MAX_FILE = 100_000_000, CHUNK = 2_000_000, TTL = 120_000;
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
function metadata(p, course) {
  let url; try { url = new URL(p.url); } catch { fail('INVALID_FILE_METADATA'); }
  if (p.courseId !== course || !/^\d{1,12}$/u.test(course) || url.origin !== 'https://moodle.telt.unsw.edu.au' || url.username || url.password ||
      url.href.length > 2048 || !(url.pathname.startsWith('/pluginfile.php/') || url.pathname === '/mod/resource/view.php' || /\.(pdf|docx|pptx|xlsx|txt|csv)$/iu.test(url.pathname)) ||
      typeof p.title !== 'string' || !p.title.trim() || p.title.length > 250 || typeof p.section !== 'string' || p.section.length > 150 ||
      typeof p.mime !== 'string' || p.mime.length > 150 || !Number.isSafeInteger(p.size) || p.size <= 0 || p.size > MAX_FILE) fail('INVALID_FILE_METADATA');
  return { courseId: course, url: p.url, title: p.title, section: p.section, mime: p.mime, size: p.size };
}
export function createFileUpload({ extract = extractFileBytes, now = Date.now } = {}) {
  const jobs = new Map();
  const remove = id => {
    const job = jobs.get(id); if (!job) return;
    clearTimeout(job.timer); for (const chunk of job.chunks) chunk.fill(0); job.chunks.length = 0; jobs.delete(id);
  };
  return Object.freeze({
    async handle(account, course, p) {
      if (typeof account !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(account) || typeof course !== 'string' || !/^\d{1,12}$/u.test(course)) fail('BOUND_CONTEXT_REQUIRED', 403);
      if (p?.action === 'begin') {
        if (!exact(p, ['action', 'courseId', 'url', 'title', 'section', 'mime', 'size'])) fail('INVALID_REQUEST');
        const info = metadata(p, course);
        for (const [id, job] of jobs) if (!job.processing && job.expiresAt <= now()) remove(id);
        if (jobs.size >= 2 || [...jobs.values()].some(job => job.account === account)) fail('FILE_UPLOAD_BUSY', 409);
        const uploadId = randomBytes(24).toString('hex'), expiresAt = now() + TTL;
        const timer = setTimeout(() => { if (!jobs.get(uploadId)?.processing) remove(uploadId); }, TTL); timer.unref?.();
        jobs.set(uploadId, { account, course, info, expiresAt, timer, chunks: [], bytes: 0, processing: false, lastOffset: -1, lastHash: '' });
        return { uploadId, chunkBytes: CHUNK, expiresAt };
      }
      if (typeof p?.uploadId !== 'string' || !/^[a-f0-9]{48}$/u.test(p.uploadId)) fail('INVALID_REQUEST');
      const job = jobs.get(p.uploadId);
      // 错误账号或课程不能消耗、终止或删除另一份上传。
      if (!job || job.account !== account || job.course !== course) fail('FILE_UPLOAD_UNAVAILABLE', 404);
      if (job.processing) fail('FILE_UPLOAD_BUSY', 409);
      if (job.expiresAt <= now()) { remove(p.uploadId); fail('FILE_UPLOAD_EXPIRED', 410); }
      if (p.action === 'abort') {
        if (!exact(p, ['action', 'uploadId'])) fail('INVALID_REQUEST');
        remove(p.uploadId); return { ok: true };
      }
      if (p.action === 'append') {
        if (!exact(p, ['action', 'uploadId', 'offset', 'base64']) || !Number.isSafeInteger(p.offset) || p.offset < 0 || typeof p.base64 !== 'string' ||
            !p.base64.length || p.base64.length > Math.ceil(CHUNK / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(p.base64)) fail('INVALID_FILE_CHUNK');
        const chunk = Buffer.from(p.base64, 'base64');
        if (!chunk.length || chunk.length > CHUNK || chunk.toString('base64') !== p.base64) fail('INVALID_FILE_CHUNK');
        const hash = createHash('sha256').update(chunk).digest('hex');
        if (p.offset === job.lastOffset && hash === job.lastHash) return { nextOffset: job.bytes };
        if (p.offset !== job.bytes || job.bytes + chunk.length > job.info.size) fail('FILE_CHUNK_ORDER');
        job.chunks.push(chunk); job.lastOffset = p.offset; job.lastHash = hash; job.bytes += chunk.length;
        return { nextOffset: job.bytes };
      }
      if (p.action === 'finish') {
        if (!exact(p, ['action', 'uploadId']) || job.bytes !== job.info.size) fail('FILE_UPLOAD_INCOMPLETE');
        job.processing = true; clearTimeout(job.timer);
        let bytes;
        try { bytes = Buffer.concat(job.chunks, job.bytes); return await extract(bytes, job.info); }
        catch (error) { fail(fileErrorCode(error), 422); }
        finally { bytes?.fill(0); remove(p.uploadId); }
      }
      fail('INVALID_REQUEST');
    },
    dispose() { for (const id of jobs.keys()) remove(id); }
  });
}
