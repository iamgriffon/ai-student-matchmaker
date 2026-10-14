let recommendationWorker = null;
window.rankRecommendations = (data, signal) => new Promise((resolve, reject) => {
  const worker = recommendationWorker ??= new Worker("/generated/recommendation-worker.js");
  const stop = (terminate = false) => {
    if (terminate) { worker.terminate(); recommendationWorker = null; }
    worker.onmessage = null;
    worker.onerror = null;
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    stop(true);
    reject(new DOMException("Recommendation cancelled.", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { abort(); return; }
  worker.onerror = (event) => { stop(true); reject(new Error(event.message || "Could not load recommendation inference.")); };
  worker.onmessage = ({ data: result }) => {
    stop(Boolean(result.error));
    if (result.error) { reject(new Error(result.error)); return; }
    const { inference, ...response } = data;
    resolve({ ...response, recommendations: result.recommendations });
  };
  worker.postMessage(data.inference);
});
