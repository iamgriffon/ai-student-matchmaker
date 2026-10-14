(() => {
  const POLL_INTERVAL_MS = 2000;
  const PROGRESS_PERCENT_MAX = 100;
  const FIRST_ITERATION = 1;
  const BYTES_PER_MIB = 1024 * 1024;
  const MEMORY_PRECISION = 2;
  const start = document.getElementById("start-training");
  const clear = document.getElementById("clear-training-data");
  const compare = document.getElementById("compare-learning-rates");
  const dialog = document.getElementById("training-dialog");
  const form = document.getElementById("training-form");
  const learningRateInput = document.getElementById("training-learning-rate");
  const batchSizeInput = document.getElementById("training-batch-size");
  const epochsInput = document.getElementById("training-epochs");
  const formError = document.getElementById("training-form-error");
  const submit = document.getElementById("submit-training");
  const closeDialog = document.getElementById("close-training-dialog");
  const cancel = document.getElementById("cancel-training");
  const message = document.getElementById("training-operation-status");
  const banner = document.getElementById("model-required");
  const heading = document.getElementById("model-required-heading");
  const progress = document.getElementById("training-progress");
  let canManageTraining = false;
  let browserTraining = null;
  let requesting = false;
  let refreshPromise = null;
  let timer = null;
  let lastStatus = null;
  let useTrainEndpoint = false;
  let lastSnapshot = null;
  let trackingStream = null;
  let trackingJobId = null;
  let streamFallbackJobId = null;

  function closeTrackingStream() {
    trackingStream?.close();
    trackingStream = null;
    trackingJobId = null;
  }
  function trackWithStream(data) {
    if (browserTraining) return true;
    if (!data.trainingStream || typeof EventSource == 'undefined') return false;
    const jobId = data.training.jobId ?? "current";
    if (streamFallbackJobId === jobId) return false;
    if (trackingStream && trackingJobId === jobId) return true;
    closeTrackingStream();
    const source = new EventSource(data.trainingStream);
    trackingStream = source;
    trackingJobId = jobId;
    const fallback = () => {
      if (trackingStream !== source) return;
      streamFallbackJobId = jobId;
      closeTrackingStream();
      clearTimeout(timer);
      timer = setTimeout(refresh, POLL_INTERVAL_MS);
    };
    source.addEventListener("training-progress", (event) => {
      if (trackingStream !== source) return;
      try {
        const update = JSON.parse(event.data);
        renderStatus({ ...lastSnapshot, training: update.training });
        if (!["running", "clearing"].includes(update.training.status)) refresh();
      } catch { fallback(); }
    });
    source.addEventListener("stream-renew", () => {
      if (trackingStream !== source) return;
      closeTrackingStream();
      if (lastSnapshot && ["running", "clearing"].includes(lastSnapshot.training.status)) trackWithStream(lastSnapshot);
    });
    source.addEventListener("stream-failed", fallback);
    source.onerror = fallback;
    return true;
  }

  async function updateBrowserJob(jobId, update) {
    const response = await fetch("/api/train?action=update", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, ...update }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save browser training.");
    return data;
  }
  function startBrowserWorker(result) {
    const worker = new Worker("/generated/training-worker.js");
    const jobId = result.training.jobId;
    browserTraining = { worker, jobId };
    closeTrackingStream();
    let writes = Promise.resolve();
    let lastHeartbeat = 0;
    let finishing = false;
    const HEARTBEAT_INTERVAL_MS = 5000;
    const finish = async (error = null) => {
      if (finishing) return;
      finishing = true;
      worker.terminate();
      if (error) {
        await updateBrowserJob(jobId, { action: "failed" }).catch(() => {});
      }
      browserTraining = null;
      await refresh();
      if (error) message.textContent = error.message;
    };
    worker.onerror = (event) => { finish(new Error(event.message || "Could not load the browser training worker.")); };
    worker.onmessage = ({ data }) => {
      if (finishing) return;
      if (data.type === "progress") {
        renderStatus({ ...lastSnapshot, training: { ...result.training, ...data.progress, status: "running" } });
        if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeat = Date.now();
          writes = writes.then(() => updateBrowserJob(jobId, { action: "progress", progress: data.progress }));
          writes.catch(finish);
        }
      } else if (data.type === "model") {
        writes = writes.then(() => updateBrowserJob(jobId, { action: "model", iteration: data.iteration, artifact: data.artifact, report: data.report }));
        writes.catch(finish);
      } else if (data.type === "complete") {
        writes.then(() => updateBrowserJob(jobId, { action: "complete" })).then(() => finish()).catch(finish);
      } else if (data.type === "failed") finish(new Error(data.message));
    };
    worker.postMessage({ context: result.context, options: result.options });
  }

  async function request(method = "GET", options = null) {
    const params = options ? new URLSearchParams({
      learningRate: String(options.learningRate), epochs: String(options.epochs), ...(typeof options.batchSize == 'undefined' ? {} : { batchSize: String(options.batchSize) }),
      compareLearningRates: String(options.compareLearningRates),
    }) : null;
    const path = method === "POST" ? `${useTrainEndpoint ? "/api/train" : "/api/training"}?${params}` : method === "DELETE" && useTrainEndpoint ? "/api/train" : "/api/training";
    const response = await fetch(path, { method });
    const data = await response.json().catch(() => {
      throw new Error(window.i18n.t("The API returned an empty or invalid response (HTTP {status}). Check the Worker deployment.", { status: response.status }));
    });
    if (!response.ok) throw new Error(data.error || "Could not complete the training operation.");
    return data;
  }
  function setFormBusy(busy) {
    for (const control of [learningRateInput, epochsInput, batchSizeInput, compare, submit, closeDialog, cancel]) { if (control) control.disabled = busy; }
    submit.textContent = busy ? "Starting…" : "Start training";
  }
  function renderStatus(data) {
    lastSnapshot = { ...lastSnapshot, ...data };
    data = lastSnapshot;
    if (typeof data.trainingEndpoint != 'undefined' || typeof data.executor != 'undefined') {
      useTrainEndpoint = data.trainingEndpoint === "/api/train" || data.executor === "external";
    }
    canManageTraining = data.canManageTraining === true;
    const training = data.training;
    const running = training.status === "running" || training.status === "clearing";
    if (heading) heading.textContent = training.status === "running" ? "Training in progress"
      : training.status === "failed" ? "Training did not complete" : "Model training required";
    progress.hidden = training.status !== "running";
    if (training.totalEpochs && training.iteration && training.iterationCount && typeof training.epoch != 'undefined') {
      const batchFraction = training.totalBatches ? (training.batch ?? 0) / training.totalBatches : 0;
      const completedEpochs = (training.iteration - FIRST_ITERATION) * training.totalEpochs + training.epoch + batchFraction;
      progress.value = Math.min(PROGRESS_PERCENT_MAX, completedEpochs / (training.totalEpochs * training.iterationCount) * PROGRESS_PERCENT_MAX);
    } else { progress.removeAttribute("value"); }
    start.disabled = requesting || running;
    if (clear) clear.disabled = requesting || running;
    setFormBusy(requesting || running);
    start.textContent = training.status === "running" ? "Training…" : "Train model";
    if (banner) banner.hidden = data.modelReady && !running && training.status !== "failed";
    message.textContent = running || training.status === "failed" ? window.i18n.t(training.message)
      : data.modelReady ? "A trained model is available." : "Model training required.";
    if (running && typeof training.tensorBytes === "number") {
      const memory = (training.tensorBytes / BYTES_PER_MIB).toLocaleString(window.i18n.locale, { maximumFractionDigits: MEMORY_PRECISION });
      message.textContent += ` · ${window.i18n.t("Tensor memory: {memory} MiB", { memory })}`;
    }
    document.dispatchEvent(new CustomEvent("training-model-status", { detail: data }));
    const statusKey = `${training.status}:${training.finishedAt}`;
    if (lastStatus !== null && lastStatus !== statusKey && !running) {
      document.dispatchEvent(new CustomEvent("training-data-changed"));
    }
    lastStatus = statusKey;
    clearTimeout(timer);
    if (!running) closeTrackingStream();
    timer = running && !trackWithStream(data) ? setTimeout(refresh, POLL_INTERVAL_MS) : null;
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try { renderStatus(await request()); }
      catch (error) {
        if (banner) banner.hidden = false;
        if (heading) heading.textContent = "Could not load model status";
        start.disabled = true;
        message.textContent = error.message;
        clearTimeout(timer);
        timer = setTimeout(refresh, POLL_INTERVAL_MS);
      }
    })();
    try { await refreshPromise; }
    finally { refreshPromise = null; }
  }
  async function mutate(method, options = null) {
    if (requesting || start.disabled) return;
    if (!canManageTraining) { window.location.assign("/api/train?login=true"); return; }
    if (method === "DELETE" && !window.confirm(window.i18n.t("Delete ALL pair vectors, models and training reports? Students and started study pairs will be preserved."))) return;
    requesting = true;
    start.disabled = true;
    if (clear) clear.disabled = true;
    setFormBusy(true);
    closeTrackingStream();
    await refreshPromise;
    clearTimeout(timer);
    message.textContent = method === "DELETE" ? "Deleting training data…" : "Starting training…";
    let operationError = null;
    try {
      const result = await request(method, options);
      if (method === "DELETE") {
        document.dispatchEvent(new CustomEvent("training-data-cleared"));
        renderStatus({ ...result, modelReady: false, modelId: null });
      }
      if (method === "POST") {
        dialog.close();
        if (result.executor === "browser") startBrowserWorker(result);
      }
      document.dispatchEvent(new CustomEvent("training-data-changed"));
    } catch (error) { operationError = error.message; }
    finally {
      requesting = false;
      start.disabled = false;
      if (clear) clear.disabled = false;
      setFormBusy(false);
      await refreshPromise;
      await refresh();
      if (operationError) {
        message.textContent = operationError;
        if (banner) banner.hidden = false;
        if (method === "POST") { formError.textContent = operationError; formError.hidden = false; }
      }
    }
  }
  start.addEventListener("click", () => {
    if (start.disabled || requesting) return;
    if (!canManageTraining) { window.location.assign("/api/train?login=true"); return; }
    formError.hidden = true;
    dialog.showModal();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requesting || start.disabled || !form.reportValidity()) return;
    const learningRate = Number(learningRateInput.value);
    const epochs = Number(epochsInput.value);
    const batchSize = batchSizeInput ? Number(batchSizeInput.value) : undefined;
    if (!Number.isFinite(learningRate) || learningRate <= 0 || !Number.isInteger(epochs) || epochs <= 0) {
      formError.textContent = "Enter a positive learning rate and a positive integer for iterations.";
      formError.hidden = false;
      return;
    }
    formError.hidden = true;
    await mutate("POST", { learningRate, epochs, batchSize, compareLearningRates: compare.checked });
  });
  for (const button of [closeDialog, cancel]) button.addEventListener("click", () => { if (!requesting) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (requesting) event.preventDefault(); });
  clear?.addEventListener("click", () => mutate("DELETE"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("beforeunload", (event) => {
    if (browserTraining) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => {
    closeTrackingStream();
    if (browserTraining) {
      const { worker, jobId } = browserTraining;
      worker.terminate();
      browserTraining = null;
      navigator.sendBeacon("/api/train?action=update", new Blob([JSON.stringify({ jobId, action: "failed" })], { type: "application/json" }));
    }
  });
  window.addEventListener("pageshow", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("locale-changed", refresh);
  refresh();
})();
