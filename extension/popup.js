const MOODLE_ORIGIN = 'https://moodle.telt.unsw.edu.au';
const MOODLE_HOME = `${MOODLE_ORIGIN}/my/courses.php`;

function validMoodleTab(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) return false;
  try {
    const url = new URL(tab.url || '');
    return url.protocol === 'https:' && url.origin === MOODLE_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

function pickMoodleTab(tabs) {
  return (Array.isArray(tabs) ? tabs : [])
    .filter(validMoodleTab)
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
}

async function moodleTabs() {
  const tabs = await chrome.tabs.query({ url: `${MOODLE_ORIGIN}/*` });
  return tabs.filter(validMoodleTab);
}

function setBusy(busy) {
  for (const id of ['open-moodle-top', 'open-moodle-main']) {
    const button = document.getElementById(id);
    if (button) button.disabled = busy;
  }
}

async function openOrFocusMoodle() {
  const status = document.getElementById('status');
  setBusy(true);
  if (status) status.textContent = '正在打开课程中心…';
  try {
    const tab = pickMoodleTab(await moodleTabs());
    if (tab) {
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      await chrome.tabs.create({ url: MOODLE_HOME, active: true });
    }
    window.close();
  } catch {
    if (status) status.textContent = '暂时无法打开 Moodle，请稍后重试。';
    setBusy(false);
  }
}

async function showMoodleAccount() {
  const name = document.getElementById('account-name');
  const detail = document.getElementById('account-detail');
  try {
    const tab = pickMoodleTab(await moodleTabs());
    if (!tab) {
      detail.textContent = '尚未打开 UNSW Moodle';
      return;
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (result?.ok && /^\d{1,20}$/.test(String(result.accountId || ''))) {
      name.textContent = '已连接 UNSW Moodle';
      detail.textContent = '个人学习空间';
      return;
    }
    detail.textContent = 'UNSW Moodle 已打开';
  } catch {
    detail.textContent = 'UNSW Moodle 已打开';
  }
}

function initPopup() {
  const version = chrome.runtime.getManifest().version;
  document.getElementById('version').textContent = `Askme v${version}`;
  document.getElementById('open-moodle-top').addEventListener('click', openOrFocusMoodle);
  document.getElementById('open-moodle-main').addEventListener('click', openOrFocusMoodle);
  showMoodleAccount();
}

document.addEventListener('DOMContentLoaded', initPopup);
