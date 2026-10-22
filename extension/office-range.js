// 只传输 Office 正文 XML；原始链接仍由调用方保留为课程证据来源。
// ZIP 结构依据 PKWARE APPNOTE 6.3.10，Range/If-Range 依据 RFC 9110。
(() => {
  'use strict';
  const LIMIT = Object.freeze({ suffix: 65_557, directory: 2_000_000, entries: 2_000,
    parts: 100, compressed: 20_000_000, expanded: 80_000_000, entry: 15_000_000,
    headers: 1_000_000, requests: 220 });
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const need = (ok, message, code = 'OFFICE_RANGE_INVALID_ZIP') => { if (!ok) fail(code, message); };
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const aborted = signal => { if (signal?.aborted) fail('OFFICE_RANGE_ABORTED', 'Office 文件读取已取消'); };
  const cancel = async body => { try { await body?.cancel(); } catch { /* 保留原始错误。 */ } };

  function safeUrl(value, origin) {
    need((typeof value === 'string' && value.trim().length > 0) || value instanceof URL,
      'Office 文件地址无效', 'OFFICE_RANGE_ORIGIN');
    let parsed;
    try { parsed = new URL(value, origin); } catch { fail('OFFICE_RANGE_ORIGIN', 'Office 文件地址无效'); }
    need(/^https?:$/.test(parsed.protocol) && parsed.origin === origin && !parsed.username && !parsed.password,
      'Office 文件必须位于当前 Moodle 站点', 'OFFICE_RANGE_ORIGIN');
    parsed.hash = '';
    return parsed.href;
  }

  function dateValue(value) {
    // 只接收明确的 HTTP 日期；非法日期不能作为文件一致性凭据。
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return NaN;
    const number = Date.parse(value);
    return Number.isFinite(number) && new Date(number).toUTCString() === value ? number : NaN;
  }

  function extraFields(bytes) {
    const data = view(bytes);
    for (let offset = 0; offset < bytes.length;) {
      need(offset + 4 <= bytes.length, 'Office ZIP 扩展字段不完整');
      const id = data.getUint16(offset, true), length = data.getUint16(offset + 2, true);
      need(offset + 4 + length <= bytes.length, 'Office ZIP 扩展字段越界');
      need(![0x0001, 0x0017, 0x9901].includes(id), '暂不支持 ZIP64 或加密 Office 文件', 'OFFICE_RANGE_UNSUPPORTED');
      offset += 4 + length;
    }
  }

  function entryName(bytes, flags) {
    need(bytes.length > 0 && bytes.length <= 4_096, 'Office ZIP 文件名长度无效');
    let name;
    if (flags & 0x0800) {
      try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { fail('OFFICE_RANGE_INVALID_ZIP', 'Office ZIP 文件名编码无效'); }
    } else {
      // 正文路径为 ASCII；其他编码的名字保守拒绝，避免错误解码后的路径歧义。
      need(bytes.every(value => value < 0x80), '暂不支持此 ZIP 文件名编码', 'OFFICE_RANGE_UNSUPPORTED');
      name = String.fromCharCode(...bytes);
    }
    need(!/[\u0000-\u001f\u007f\\:]/.test(name) && !name.startsWith('/') && name.normalize('NFC') === name,
      'Office ZIP 包含不安全的文件名');
    const segments = name.replace(/\/$/, '').split('/');
    need(segments.every(segment => segment && segment !== '.' && segment !== '..'), 'Office ZIP 包含不安全的路径');
    return name;
  }

  function directoryInfo(tail, total) {
    const data = view(tail);
    let offset = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === tail.length) { offset = i; break; }
    }
    need(offset >= 0, '未找到完整的 Office ZIP 目录');
    const absolute = total - tail.length + offset;
    need(offset < 20 || data.getUint32(offset - 20, true) !== 0x07064b50,
      '暂不支持 ZIP64 Office 文件', 'OFFICE_RANGE_UNSUPPORTED');
    const disk = data.getUint16(offset + 4, true), directoryDisk = data.getUint16(offset + 6, true);
    const diskEntries = data.getUint16(offset + 8, true), count = data.getUint16(offset + 10, true);
    const size = data.getUint32(offset + 12, true), start = data.getUint32(offset + 16, true);
    need(disk === 0 && directoryDisk === 0 && diskEntries === count && count !== 0xffff && size !== 0xffffffff && start !== 0xffffffff,
      '暂不支持 ZIP64 或分卷 Office 文件', 'OFFICE_RANGE_UNSUPPORTED');
    need(count > 0 && count <= LIMIT.entries && size > 0 && size <= LIMIT.directory,
      'Office ZIP 目录超过读取上限', 'OFFICE_RANGE_BUDGET');
    need(start + size === absolute && start >= 30, 'Office ZIP 目录位置无效');
    return { count, size, start };
  }

  function parseDirectory(bytes, info) {
    const data = view(bytes), entries = [], names = new Set(), offsets = new Set();
    let offset = 0;
    for (let index = 0; index < info.count; index++) {
      need(offset + 46 <= bytes.length && data.getUint32(offset, true) === 0x02014b50, 'Office ZIP 目录记录无效');
      const version = data.getUint16(offset + 6, true), flags = data.getUint16(offset + 8, true);
      const method = data.getUint16(offset + 10, true), crc = data.getUint32(offset + 16, true);
      const compressed = data.getUint32(offset + 20, true), expanded = data.getUint32(offset + 24, true);
      const nameLength = data.getUint16(offset + 28, true), extraLength = data.getUint16(offset + 30, true);
      const commentLength = data.getUint16(offset + 32, true), disk = data.getUint16(offset + 34, true);
      const local = data.getUint32(offset + 42, true), end = offset + 46 + nameLength + extraLength + commentLength;
      need(end <= bytes.length, 'Office ZIP 目录记录越界');
      need(version < 45 && !(flags & ~0x080e) && disk === 0 && ![compressed, expanded, local].includes(0xffffffff),
        '暂不支持 ZIP64、加密或特殊 ZIP 文件', 'OFFICE_RANGE_UNSUPPORTED');
      const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength), name = entryName(nameBytes, flags);
      extraFields(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
      need(!names.has(name.toLowerCase()) && !offsets.has(local), 'Office ZIP 包含重复文件或重叠目录');
      need(local + 30 + nameLength + compressed <= info.start, 'Office ZIP 正文位置无效');
      names.add(name.toLowerCase()); offsets.add(local);
      entries.push({ name, nameBytes, version, flags, method, crc, compressed, expanded, local });
      offset = end;
    }
    need(offset === bytes.length, 'Office ZIP 目录大小不一致');
    const ordered = [...entries].sort((a, b) => a.local - b.local);
    ordered.forEach((entry, index) => {
      entry.boundary = ordered[index + 1]?.local ?? info.start;
      need(entry.local + 30 + entry.nameBytes.length + entry.compressed <= entry.boundary, 'Office ZIP 条目发生重叠');
    });
    return entries;
  }

  function selectEntries(entries, maxBytes) {
    const words = entries.filter(entry => entry.name === 'word/document.xml');
    const slides = entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
    const sheets = entries.filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
    need([words, slides, sheets].filter(group => group.length).length === 1, 'Office 正文结构缺失或格式不明确', 'OFFICE_RANGE_UNSUPPORTED');
    const kind = words.length ? 'docx' : slides.length ? 'pptx' : 'xlsx';
    const physical = words.length ? words : slides.length ? slides : sheets;
    // 不截取前 100 页：超限时整个操作失败，防止缺页却被标记为完整。
    need(physical.length <= LIMIT.parts, 'Office 正文页数超过 Range 读取上限', 'OFFICE_RANGE_BUDGET');
    const selected = [...physical];
    if (kind === 'xlsx') selected.push(...entries.filter(entry => entry.name === 'xl/sharedStrings.xml'));
    selected.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    let compressed = 0, expanded = 0, zipBytes = 22;
    for (const entry of selected) {
      need([0, 8].includes(entry.method), 'Office 正文使用了不支持的压缩格式', 'OFFICE_RANGE_UNSUPPORTED');
      need(entry.method !== 0 || entry.compressed === entry.expanded, 'Office ZIP 未压缩正文大小不一致');
      need(entry.expanded <= LIMIT.entry, '单个 Office 正文超过解压上限', 'OFFICE_RANGE_BUDGET');
      compressed += entry.compressed; expanded += entry.expanded;
      zipBytes += 76 + 2 * entry.nameBytes.length + entry.compressed;
    }
    need(compressed <= LIMIT.compressed && expanded <= LIMIT.expanded && zipBytes <= maxBytes,
      'Office 正文超过 Range 传输预算', 'OFFICE_RANGE_BUDGET');
    return { selected, kind, parts: physical.length, compressed, expanded, zipBytes };
  }

  function zipHeaders(entry, offset) {
    // 删除可选扩展和数据描述符，重新写入已知大小；压缩正文与 CRC 原样保留。
    // 时间戳固定，以正文 ZIP 的摘要建立稳定缓存，不受原包媒体或时间戳变化影响。
    const local = new Uint8Array(30 + entry.nameBytes.length), central = new Uint8Array(46 + entry.nameBytes.length);
    const a = view(local), b = view(central), flags = entry.flags & ~8;
    a.setUint32(0, 0x04034b50, true); a.setUint16(4, 20, true); a.setUint16(6, flags, true);
    a.setUint16(8, entry.method, true); a.setUint16(12, 33, true); a.setUint32(14, entry.crc, true);
    a.setUint32(18, entry.compressed, true); a.setUint32(22, entry.expanded, true);
    a.setUint16(26, entry.nameBytes.length, true); local.set(entry.nameBytes, 30);
    b.setUint32(0, 0x02014b50, true); b.setUint16(4, 20, true); b.setUint16(6, 20, true);
    b.setUint16(8, flags, true); b.setUint16(10, entry.method, true); b.setUint16(14, 33, true);
    b.setUint32(16, entry.crc, true); b.setUint32(20, entry.compressed, true); b.setUint32(24, entry.expanded, true);
    b.setUint16(28, entry.nameBytes.length, true); b.setUint32(42, offset, true); central.set(entry.nameBytes, 46);
    return { local, central };
  }

  async function extract({ url, fetchImpl = globalThis.fetch, signal, maxBytes = LIMIT.compressed } = {}) {
    try {
      aborted(signal);
      need(typeof fetchImpl === 'function' && Number.isSafeInteger(maxBytes) && maxBytes >= 22 && maxBytes <= LIMIT.compressed,
        'Office Range 参数无效', 'OFFICE_RANGE_ARGUMENT');
      const origin = globalThis.location?.origin;
      need(typeof origin === 'string' && /^https?:\/\//.test(origin), 'Office Range 必须在 Moodle 页面中运行', 'OFFICE_RANGE_ORIGIN');
      const originalUrl = safeUrl(url, origin);
      let resolvedUrl = '', total = 0, etag = '', lastModified = '', validator = '', downloaded = 0, requests = 0;
      const wireLimit = maxBytes + LIMIT.suffix + LIMIT.directory + LIMIT.headers;

      async function range(start, end, suffix = false) {
        aborted(signal);
        need(++requests <= LIMIT.requests, 'Office Range 请求次数超过上限', 'OFFICE_RANGE_BUDGET');
        const requested = suffix ? LIMIT.suffix : end - start + 1;
        need(suffix || (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end < total), 'Office Range 位置无效');
        need(requested <= wireLimit - downloaded, 'Office Range 下载预算不足', 'OFFICE_RANGE_BUDGET');
        const headers = { Range: suffix ? `bytes=-${LIMIT.suffix}` : `bytes=${start}-${end}` };
        if (validator) headers['If-Range'] = validator;
        let response;
        try {
          // same-origin 模式同时禁止重定向链跨站；只使用浏览器正常的 Moodle 凭据。
          response = await fetchImpl(resolvedUrl || originalUrl, { method: 'GET', mode: 'same-origin',
            credentials: 'same-origin', redirect: 'follow', cache: 'no-store', signal, headers });
          need(response.status === 206, response.status === 200 ? 'Moodle 未提供分段下载，已停止读取完整文件' : `Office Range HTTP ${response.status}`,
            response.status === 200 ? 'OFFICE_RANGE_UNSUPPORTED' : 'OFFICE_RANGE_HTTP');
          const finalUrl = safeUrl(response.url, origin);
          need(!resolvedUrl || resolvedUrl === finalUrl, 'Office 下载地址在读取期间发生变化', 'OFFICE_RANGE_CHANGED_URL');
          need(!/multipart\/byteranges/i.test(response.headers.get('content-type') || ''), '不支持多段 Range 响应', 'OFFICE_RANGE_UNSUPPORTED');
          const encoding = response.headers.get('content-encoding');
          need(!encoding || encoding.toLowerCase() === 'identity', 'Office Range 响应经过内容编码', 'OFFICE_RANGE_UNSUPPORTED');
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          need(match, 'Office Range 响应缺少有效 Content-Range', 'OFFICE_RANGE_HTTP');
          const [first, last, size] = match.slice(1).map(Number);
          need([first, last, size].every(Number.isSafeInteger) && size > 0 && size < 0xffffffff && first >= 0 && last >= first && last < size,
            'Office Range 响应范围无效', 'OFFICE_RANGE_HTTP');
          need(!total || total === size, 'Office 文件大小在读取期间发生变化', 'OFFICE_RANGE_CHANGED_SIZE');
          need(suffix ? first === Math.max(0, size - LIMIT.suffix) && last === size - 1 : first === start && last === end,
            'Office Range 返回了错误的文件区间', 'OFFICE_RANGE_HTTP');
          const expected = last - first + 1, length = response.headers.get('content-length');
          need(length === null || (/^\d+$/.test(length) && Number(length) === expected), 'Office Range 响应长度不一致', 'OFFICE_RANGE_HTTP');
          const nextEtag = response.headers.get('etag') || '', nextModified = response.headers.get('last-modified') || '';
          if (!total) {
            need(nextEtag.length <= 512 && nextModified.length <= 100, 'Office 版本凭据无效', 'OFFICE_RANGE_NO_VALIDATOR');
            if (/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(nextEtag)) validator = nextEtag;
            else {
              const modified = dateValue(nextModified), dated = dateValue(response.headers.get('date') || '');
              need(!nextEtag && Number.isFinite(modified) && Number.isFinite(dated) && dated - modified >= 60_000,
                'Moodle 未提供可靠的文件版本凭据', 'OFFICE_RANGE_NO_VALIDATOR');
              validator = nextModified;
            }
            total = size; etag = nextEtag; lastModified = nextModified; resolvedUrl = finalUrl;
          } else if (etag) {
            // If-Range 已绑定强 ETag；次要日期头的变化不能推翻相同的强版本标识。
            need(nextEtag === etag, 'Office 文件 ETag 在读取期间发生变化', 'OFFICE_RANGE_CHANGED_ETAG');
          } else {
            // 无 ETag 时仍严格绑定经过首响应时间校验的 Last-Modified，不降级验证。
            need(!nextEtag && nextModified === lastModified, 'Office 文件修改日期凭据在读取期间发生变化', 'OFFICE_RANGE_CHANGED_DATE');
          }
          need(response.body?.getReader, 'Office Range 响应没有可读取的文件流', 'OFFICE_RANGE_HTTP');
          const reader = response.body.getReader(), result = new Uint8Array(expected);
          let received = 0;
          try {
            while (true) {
              aborted(signal);
              const { done, value } = await reader.read();
              if (done) break;
              aborted(signal);
              need(value instanceof Uint8Array && received + value.byteLength <= expected, 'Office Range 响应超过预期长度', 'OFFICE_RANGE_HTTP');
              downloaded += value.byteLength;
              need(downloaded <= wireLimit, 'Office Range 下载超过预算', 'OFFICE_RANGE_BUDGET');
              result.set(value, received); received += value.byteLength;
            }
            need(received === expected, 'Office Range 响应不完整', 'OFFICE_RANGE_HTTP');
            return result;
          } catch (error) { try { await reader.cancel(); } catch { /* 保留原始错误。 */ } throw error; }
          finally { reader.releaseLock(); }
        } catch (error) { await cancel(response?.body); throw error; }
      }

      const tail = await range(0, 0, true), info = directoryInfo(tail, total);
      const directory = await range(info.start, info.start + info.size - 1);
      const entries = parseDirectory(directory, info), selection = selectEntries(entries, maxBytes);
      const localChunks = [], centralChunks = [];
      let outputOffset = 0, headerBytes = 0;
      async function readEntry(entry) {
        const header = await range(entry.local, entry.local + 29), data = view(header);
        need(data.getUint32(0, true) === 0x04034b50 && data.getUint16(4, true) === entry.version &&
          data.getUint16(6, true) === entry.flags && data.getUint16(8, true) === entry.method, 'Office ZIP 本地头与目录不一致');
        const crc = data.getUint32(14, true), compressed = data.getUint32(18, true), expanded = data.getUint32(22, true);
        need(!(entry.flags & 8) ? crc === entry.crc && compressed === entry.compressed && expanded === entry.expanded :
          (crc === 0 || crc === entry.crc) && (compressed === 0 || compressed === entry.compressed) && (expanded === 0 || expanded === entry.expanded),
        'Office ZIP 本地头大小或 CRC 不一致');
        const nameLength = data.getUint16(26, true), extraLength = data.getUint16(28, true);
        need(nameLength === entry.nameBytes.length, 'Office ZIP 本地文件名长度不一致');
        headerBytes += 30 + nameLength + extraLength;
        need(headerBytes <= LIMIT.headers, 'Office ZIP 本地头超过预算', 'OFFICE_RANGE_BUDGET');
        const bodyStart = entry.local + 30, bodyEnd = bodyStart + nameLength + extraLength + entry.compressed;
        need(bodyEnd <= entry.boundary, 'Office ZIP 正文与其他条目重叠');
        const body = await range(bodyStart, bodyEnd - 1);
        need(sameBytes(body.subarray(0, nameLength), entry.nameBytes), 'Office ZIP 本地文件名与目录不一致');
        extraFields(body.subarray(nameLength, nameLength + extraLength));
        return body.subarray(nameLength + extraLength);
      }
      // 限制为四路，减少大型课件的网络往返等待；输出仍按原目录顺序重建。
      for (let start = 0; start < selection.selected.length; start += 4) {
        const batch = selection.selected.slice(start, start + 4);
        const results = await Promise.allSettled(batch.map(readEntry));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        for (let index = 0; index < batch.length; index++) {
          const entry = batch[index], rebuilt = zipHeaders(entry, outputOffset);
          localChunks.push(rebuilt.local, results[index].value);
          centralChunks.push(rebuilt.central);
          outputOffset += rebuilt.local.length + entry.compressed;
        }
      }
      aborted(signal);
      const centralSize = centralChunks.reduce((size, bytes) => size + bytes.length, 0), end = new Uint8Array(22), data = view(end);
      data.setUint32(0, 0x06054b50, true); data.setUint16(8, selection.selected.length, true);
      data.setUint16(10, selection.selected.length, true); data.setUint32(12, centralSize, true); data.setUint32(16, outputOffset, true);
      const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[selection.kind];
      const blob = new Blob([...localChunks, ...centralChunks, end], { type: mime });
      need(blob.size === selection.zipBytes && blob.size <= maxBytes, 'Office 正文 ZIP 大小不一致');
      return { blob, originalSize: total, metadata: { strategy: 'office-http-range', kind: selection.kind,
        originalUrl, resolvedUrl, etag, lastModified, archiveEntries: entries.length,
        selectedEntries: selection.selected.length, physicalParts: selection.parts, completeTextSelection: true,
        selectedCompressedBytes: selection.compressed, selectedUncompressedBytes: selection.expanded,
        downloadedBytes: downloaded, requests, subsetBytes: blob.size } };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') fail('OFFICE_RANGE_ABORTED', 'Office 文件读取已取消');
      if (typeof error?.code === 'string' && error.code.startsWith('OFFICE_RANGE_')) throw error;
      fail('OFFICE_RANGE_FAILED', '无法安全读取 Office 文件正文');
    }
  }

  globalThis.AskmeOfficeRange = Object.freeze({ extract });
})();
