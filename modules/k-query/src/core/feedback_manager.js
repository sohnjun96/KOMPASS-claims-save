const STORAGE_KEY = "modelFeedback";
let writeQueue = Promise.resolve();

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

export const FeedbackManager = {
  async getFeedback(modelId) {
    if (!modelId) return "";
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const allFeedback = data[STORAGE_KEY] || {};
    return allFeedback[modelId] || "";
  },

  async saveFeedback(modelId, feedbackText) {
    if (!modelId || !feedbackText) return;
    return enqueueWrite(async () => {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const allFeedback = data[STORAGE_KEY] || {};
      allFeedback[modelId] = feedbackText;
      await chrome.storage.local.set({ [STORAGE_KEY]: allFeedback });
    });
  },

  async clearFeedback(modelId) {
    return enqueueWrite(async () => {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const allFeedback = data[STORAGE_KEY] || {};
      if (modelId) {
        delete allFeedback[modelId];
        await chrome.storage.local.set({ [STORAGE_KEY]: allFeedback });
        return;
      }
      await chrome.storage.local.remove(STORAGE_KEY);
    });
  }
};
