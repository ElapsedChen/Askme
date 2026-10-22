'use strict';
document.getElementById('open').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: 'https://moodle.telt.unsw.edu.au/my/', active: true }); }
  catch { document.getElementById('status').textContent = '请在 Chrome 中打开 Moodle 课程中心。'; }
});
