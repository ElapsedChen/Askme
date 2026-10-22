// 新构建只注册账号绑定的业务 broker，旧 iframe/任意资料 mutation 入口已移除。
importScripts('ui-protocol.js', 'ui-broker.js', 'sync-health.js', 'account-store.js', 'learning-core.js', 'knowledge-units.js', 'unit-progress.js', 'deadline-sources.js', 'plan-transport.js', 'course-service.js', 'capture-service.js', 'learning-service.js', 'study-service.js', 'conversation-skills.js', 'ui-runtime.js');
const shadowUiBuild = String(chrome.runtime.getManifest().version_name || '').split('·').at(-1).trim();
const accessReady = Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  ]);
// worker 事件监听器必须同步注册，权限收敛完成后再执行请求。
AskmeUiRuntime.install({ chromeApi: chrome, buildVersion: shadowUiBuild, ready: accessReady });
void accessReady.catch(() => console.error('ASKME_BACKGROUND_INITIALIZATION_FAILED'));
// Chrome action 使用独立 popup，关闭旧版本遗留的工具栏侧栏行为。
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
