// 统一投影同步覆盖率与缺口；不把不支持的格式冒充已读取，也不重复计算活动错误。
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const short = value => typeof value === 'string' ? value.slice(0, 250) : '';
  function report(snapshot) {
    const data = snapshot || {}, files = list(data.files), items = [];
    const add = (kind, title, reason, url = '', retryable = false) => items.push({ kind, title: short(title), reason, url, retryable });
    for (const file of files) {
      if (file.indexStatus === 'indexed') continue;
      const status = ['pending', 'failed', 'partial', 'unsupported'].includes(file.indexStatus) ? file.indexStatus : 'pending';
      const reason = status === 'pending' ? '等待继续读取' : status === 'unsupported' ? '此格式暂不支持正文提取' : status === 'partial'
        ? (list(file.emptyPages).length && !count(file.truncatedParts) && count(file.missingParts) === file.emptyPages.length
          ? `正文已保存；第 ${file.emptyPages.join('、')} 页未提取到可靠文字，请查看原页图片`
          : `已读取 ${count(file.indexedParts)} / ${count(file.totalParts)} 页或分段，部分正文仍缺失`)
        : ({ FILE_NOT_FOUND: 'Moodle 资源记录不存在，请在课程原页核对', FILE_TOO_LARGE: '文件或解压内容超过读取上限', FILE_SOURCE_CHANGED: '读取时文件发生更新，请重试',
          FILE_SOURCE_URL_CHANGED: '分段读取时文件地址发生变化，请重试', FILE_SOURCE_SIZE_CHANGED: '分段读取时文件大小发生变化，请重试',
          FILE_SOURCE_VERSION_CHANGED: '分段读取时文件版本发生变化，请重试', FILE_SOURCE_DATE_CHANGED: '分段读取时文件修改时间发生变化，请重试',
          FILE_RANGE_UNSUPPORTED: 'Moodle 未提供大型课件的稳定分段读取，请打开原文件查看', FILE_NO_TEXT: '未发现可提取文字，可能是图片或扫描件', FILE_ACCESS_DENIED: 'Moodle 当前不允许读取', FILE_NOT_DOCUMENT: '返回内容不是可读取的文档', FILE_TIMEOUT: '读取超时，可重试', FILE_UPLOAD_BUSY: '有文件正在传输，请稍后重试', FILE_UPLOAD_EXPIRED: '文件传输已超时，请重试', FILE_UNSUPPORTED: '此文档格式暂不支持', FILE_SERVICE_UNAVAILABLE: '本机文件解析服务无法连接' }[file.errorCode] || '文件读取失败，可重试');
      add(status, file.title, reason, file.url, ['failed', 'partial', 'pending'].includes(status));
    }
    for (const activity of list(data.failedActivities)) add('page', activity.title, '页面读取失败，请更新课程重试', activity.url);
    // errors 与 failedActivities 在当前扫描器中记录同一失败；仅剔除明确对应的重复项。
    const activityErrors = new Set(list(data.failedActivities).map(activity => `${activity.title}: ${activity.error}`));
    for (const error of new Set(list(data.errors))) if (!activityErrors.has(error)) add('page', '课程页面', '页面扫描未完成，请更新课程重试');
    for (const activity of list(data.unavailableActivities)) add('restricted', activity.title, 'Moodle 未开放或限制访问此活动', activity.url);
    if (data.eventSyncError || data.eventsStale) add('calendar', '课程日历', '截止事项尚未重新确认');
    if (data.assessmentStale) add('assessment', '考核要求', '考核要求尚未完整确认');
    if (data.assignmentBriefStale) {
      const failed = list(data.assignmentBriefResults).filter(item => item.status === 'failed' && /^\d{1,12}$/u.test(String(item.activityId)));
      const links = list(data.pages).flatMap(page => list(page.links));
      for (const item of failed) {
        const url = `https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=${item.activityId}`;
        const title = links.find(link => link.url === url)?.title || `作业说明 ${item.activityId}`;
        const reason = { 'login-required': '需要重新登录 Moodle', timeout: '活动页读取超时', forbidden: 'Moodle 不允许访问此活动',
          'not-found': '活动页不存在', 'unexpected-redirect': '活动页跳转到了其他页面', 'course-mismatch': '无法确认活动所属课程',
          'sensitive-dom': '说明与提交或评分区域混合，需在原页查看', truncated: '活动说明超过读取范围',
          'unsupported-template': '未找到独立的作业说明区域', 'empty-intro': '作业说明区域没有可读取文字' }[item.errorCode] || '作业说明读取失败';
        add('assignment', title, reason, url);
      }
      if (!failed.length || data.assignmentBriefScan?.overflow) add('assignment', '作业说明', '部分作业说明尚未完整读取');
    }
    if (data.skippedPages || data.skippedCourseParts) add('page-limit', '课程页面', '页面数量超过本次扫描范围');
    const truncated = list(data.pages).filter(page => page.sourceType !== 'file' && page.textTruncated).length;
    if (truncated) add('page-truncated', '课程页面', `${truncated} 个页面正文被截断`);
    const pendingFiles = files.filter(file => !file.indexStatus || file.indexStatus === 'pending').length;
    const unsupportedFiles = files.filter(file => file.indexStatus === 'unsupported').length;
    const issueCount = items.filter(item => item.kind !== 'unsupported').length;
    return { items, summary: { issueCount, pendingFiles, unsupportedFiles,
      indexedFiles: files.filter(file => file.indexStatus === 'indexed').length,
      partialFiles: files.filter(file => file.indexStatus === 'partial').length,
      failedFiles: files.filter(file => file.indexStatus === 'failed').length,
      fileCount: files.length, status: !data.syncedAt ? 'not-synced' : issueCount || unsupportedFiles ? 'partial' : 'succeeded' } };
  }
  globalThis.AskmeSyncHealth = Object.freeze({ report });
})();
