async function fetchHistoryData() {
  return new Promise((resolve, reject) => {
    chrome.history.search({ text: '', maxResults: 200 }, (historyItems) => {
      resolve(historyItems);
    });
  });
}