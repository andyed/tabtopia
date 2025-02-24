async function fetchHistoryData() {
  return new Promise((resolve, reject) => {
    chrome.history.search({ text: '', maxResults: 20 }, (historyItems) => {
      resolve(historyItems);
    });
  });
}