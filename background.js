// ツールバーのアイコンをクリックしたら、アプリ画面をタブで開く（既に開いていればそこへ移動）
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  try {
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch (e) {
    // 取得できない場合は新規に開く
  }
  chrome.tabs.create({ url });
});
