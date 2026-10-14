(() => {
  const POLL_INTERVAL_MS = 2000;
  const PROGRESS_PERCENT_MAX = 100;
  const FIRST_ITERATION = 1;
  const start = document.getElementById("start-training");
  const clear = document.getElementById("clear-training-data");
  const compare = document.getElementById("compare-learning-rates");
  const dialog = document.getElementById("training-dialog");
  const form = document.getElementById("training-form");
  const learningRateInput = document.getElementById("training-learning-rate");
  const epochsInput = document.getElementById("training-epochs");
  const formError = document.getElementById("training-form-error");
  const submit = document.getElementById("submit-training");
  const closeDialog = document.getElementById("close-training-dialog");
  const cancel = document.getElementById("cancel-training");
  const message = document.getElementById("training-operation-status");
  const banner = document.getElementById("model-required");
  const heading = document.getElementById("model-required-heading");
  const progress = document.getElementById("training-progress");
  let requesting = false;
  let refreshPromise = null;
  let timer = null;
  let lastStatus = null;
  let trainingExecutor = "workflow";

  async function request(method = "GET", options = null) {
    const params = options ? new URLSearchParams({
      learningRate: String(options.learningRate), epochs: String(options.epochs),
      compareLearningRates: String(options.compareLearningRates),
    }) : null;
    const path = method === "POST" ? `/api/training?${params}` : "/api/training";
    const response = await fetch(path, { method });
    const data = await response.json().catch(() => {
      throw new Error(window.i18n.t("The API returned an empty or invalid response (HTTP {status}). Check the Worker deployment.", { status: response.status }));
    });
    if (!response.ok) throw new Error(data.error || "Could not complete the training operation.");
    return data;
  }
  function setFormBusy(busy) {
    for (const control of [learningRateInput, epochsInput, compare, submit, closeDialog, cancel]) control.disabled = busy;
    submit.textContent = busy ? "Starting…" : trainingExecutor === "external" ? "Show local command" : "Start training";
  }
  function renderStatus(data) {
    trainingExecutor = data.executor ?? "workflow";
    const training = data.training;
    const running = training.status === "running" || training.status === "clearing";
    if (heading) heading.textContent = training.status === "running" ? "Training in progress"
      : training.status === "failed" ? "Training did not complete" : "Model training required";
    progress.hidden = training.status !== "running";
    if (training.totalEpochs && training.iteration && training.iterationCount && typeof training.epoch != 'undefined') {
      const completedEpochs = (training.iteration - FIRST_ITERATION) * training.totalEpochs + training.epoch;
      progress.value = Math.min(PROGRESS_PERCENT_MAX, completedEpochs / (training.totalEpochs * training.iterationCount) * PROGRESS_PERCENT_MAX);
    } else { progress.removeAttribute("value"); }
    start.disabled = requesting || running;
    if (clear) clear.disabled = requesting || running;
    setFormBusy(requesting || running);
    start.textContent = training.status === "running" ? "Training…" : "Train model";
    if (banner) banner.hidden = data.modelReady && !running && training.status !== "failed";
    message.textContent = running || training.status === "failed" ? training.message
      : data.modelReady ? "A trained model is available." : "Model training required.";
    document.dispatchEvent(new CustomEvent("training-model-status", { detail: data }));
    const statusKey = `${training.status}:${training.finishedAt}`;
    if (lastStatus !== null && lastStatus !== statusKey && !running) {
      document.dispatchEvent(new CustomEvent("training-data-changed"));
    }
    lastStatus = statusKey;
    clearTimeout(timer);
    timer = running ? setTimeout(refresh, POLL_INTERVAL_MS) : null;
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
    if (method === "DELETE" && !window.confirm(window.i18n.t("Delete ALL pair vectors, models and training reports? Students and started study pairs will be preserved."))) return;
    requesting = true;
    start.disabled = true;
    if (clear) clear.disabled = true;
    setFormBusy(true);
    await refreshPromise;
    clearTimeout(timer);
    message.textContent = method === "DELETE" ? "Deleting training data…" : "Starting training…";
    let operationError = null;
    try {
      await request(method, options);
      if (method === "POST") dialog.close();
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
    formError.hidden = true;
    dialog.showModal();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requesting || start.disabled || !form.reportValidity()) return;
    const learningRate = Number(learningRateInput.value);
    const epochs = Number(epochsInput.value);
    if (!Number.isFinite(learningRate) || learningRate <= 0 || !Number.isInteger(epochs) || epochs <= 0) {
      formError.textContent = "Enter a positive learning rate and a positive integer for iterations.";
      formError.hidden = false;
      return;
    }
    formError.hidden = true;
    if (trainingExecutor === "external") {
      const command = `bun run train:cloudflare --learning-rate ${learningRate} --epochs ${epochs}${compare.checked ? " --compare-learning-rates" : ""}`;
      formError.textContent = `${window.i18n.t("Run this command in your local project:")} ${command}`;
      formError.hidden = false;
      return;
    }
    await mutate("POST", { learningRate, epochs, compareLearningRates: compare.checked });
  });
  for (const button of [closeDialog, cancel]) button.addEventListener("click", () => { if (!requesting) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (requesting) event.preventDefault(); });
  clear?.addEventListener("click", () => mutate("DELETE"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("pageshow", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("locale-changed", refresh);
  refresh();
})();
