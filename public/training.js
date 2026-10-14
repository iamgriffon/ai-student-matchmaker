const trainingState = { iterations: [], selectedId: null, loading: false };
let trainingLoadRevision = 0;
let trainingLoadController = null;
const trainingElements = Object.fromEntries(["training-list", "training-detail", "training-count", "training-notice", "reload-training"].map((id) => [id, document.getElementById(id)]));
const METRIC_PRECISION = 6;
const PLOT_WIDTH = 600;
const PLOT_HEIGHT = 220;
const PLOT_PADDING = 36;
const MIN_RANGE = 0.000001;
const FIRST_EPOCH = 1;
const MIN_COMPARISON_MODELS = 2;
const trainingEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const metric = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(window.i18n.locale, { maximumFractionDigits: METRIC_PRECISION }) : "Not recorded";
const trainingDate = (value) => new Date(value).toLocaleString(window.i18n.locale);
const strategyName = (value) => value === "student-disjoint" ? "Different students in training and validation" : value === "pair-holdout" ? "Different pairs in training and validation" : "Not recorded";

function lossChart(history) {
  if (!history?.length) return '<p class="empty">No loss history for this training run.</p>';
  const losses = history.map((entry) => entry.loss);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const range = Math.max(max - min, MIN_RANGE);
  const lastEpoch = Math.max(...history.map((entry) => entry.epoch));
  const epochRange = Math.max(lastEpoch - FIRST_EPOCH, FIRST_EPOCH);
  const innerWidth = PLOT_WIDTH - PLOT_PADDING * 2;
  const innerHeight = PLOT_HEIGHT - PLOT_PADDING * 2;
  const points = history.map((entry) => `${PLOT_PADDING + (entry.epoch - FIRST_EPOCH) / epochRange * innerWidth},${PLOT_HEIGHT - PLOT_PADDING - (entry.loss - min) / range * innerHeight}`).join(" ");
  return `<svg class="loss-chart" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" role="img" aria-label="Training mean squared error per iteration"><title>Training MSE per iteration</title><line x1="${PLOT_PADDING}" y1="${PLOT_PADDING}" x2="${PLOT_PADDING}" y2="${PLOT_HEIGHT - PLOT_PADDING}" stroke="#a4b7ae"/><line x1="${PLOT_PADDING}" y1="${PLOT_HEIGHT - PLOT_PADDING}" x2="${PLOT_WIDTH - PLOT_PADDING}" y2="${PLOT_HEIGHT - PLOT_PADDING}" stroke="#a4b7ae"/><polyline fill="none" stroke="#285b48" stroke-width="2" points="${points}"/><text x="${PLOT_PADDING}" y="20">${max.toExponential(2)}</text><text x="${PLOT_PADDING}" y="${PLOT_HEIGHT - PLOT_PADDING + 16}">${min.toExponential(2)}</text><text x="${PLOT_WIDTH - PLOT_PADDING}" y="${PLOT_HEIGHT - 8}" text-anchor="end">Iteration ${lastEpoch}</text></svg>`;
}
function renderTraining() {
  trainingElements["training-count"].textContent = String(trainingState.iterations.length);
  trainingElements["reload-training"].disabled = trainingState.loading;
  trainingElements["training-list"].innerHTML = trainingState.iterations.length ? trainingState.iterations.map((row) => `<button class="training-row ${row.id === trainingState.selectedId ? "selected" : ""}" data-iteration-id="${trainingEscape(row.id)}" aria-pressed="${row.id === trainingState.selectedId}"><span class="student-name">${trainingEscape(row.modelId)} ${row.active ? '<span class="active-badge">Active</span>' : ""}</span><span class="student-summary">${trainingEscape(trainingDate(row.metadata.trainedAt))}</span><span class="student-summary">LR ${metric(row.metadata.learningRate)} · MAE ${metric(row.metadata.validationMeanAbsoluteError)}</span></button>`).join("") : '<p class="empty">No saved training runs.</p>';
  const row = trainingState.iterations.find((iteration) => iteration.id === trainingState.selectedId);
  if (!row) { trainingElements["training-detail"].innerHTML = '<p class="empty">Select a training run.</p>'; return; }
  const metadata = row.metadata;
  const report = row.trainingReport;
  const facts = [
    ["Architecture", row.architecture.join(" → ")], ["Learning rate", metric(metadata.learningRate)],
    ["Iterations", metadata.epochs], ["Batch size", report?.batchSize ?? "Not recorded"], ["Training pairs", metadata.trainingCount], ["Validation pairs", metadata.validationCount],
    ["Validation MAE", metric(metadata.validationMeanAbsoluteError)], ["Eligible-pair validation MAE", metric(metadata.eligibleValidationMeanAbsoluteError)],
    ["Validation strategy", strategyName(metadata.validationStrategy)], ["Training students", report?.trainingStudents ?? "Not recorded"],
    ["Validation students", report?.validationStudents ?? "Not recorded"], ["Excluded cross-group pairs", report?.excludedCrossGroupPairs ?? "Not recorded"],
    ["Encoder", metadata.encoderVersion], ["Policy", metadata.policyVersion], ["Trained at", trainingDate(metadata.trainedAt)],
    ["Cohort context", metadata.sourceContextVersion], ["Run ID", row.id],
  ];
  const comparison = (report?.comparisons?.length ?? 0) >= MIN_COMPARISON_MODELS ? `<div class="table-scroll"><table class="training-table"><caption>Comparison within the same training round</caption><thead><tr><th>Learning rate</th><th>Validation MAE</th><th>Eligible-pair MAE</th></tr></thead><tbody>${report.comparisons.map((candidate) => `<tr><td>${metric(candidate.learningRate)}</td><td>${metric(candidate.validationMeanAbsoluteError)}</td><td>${metric(candidate.eligibleValidationMeanAbsoluteError)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">No comparison report.</p>';
  trainingElements["training-detail"].innerHTML = `<div class="section-heading"><h2 id="training-detail-heading">${trainingEscape(row.modelId)}</h2>${row.active ? '<span class="active-badge">Active model</span>' : ""}</div><dl class="training-facts">${facts.map(([label, value]) => `<div><dt>${trainingEscape(label)}</dt><dd>${trainingEscape(value)}</dd></div>`).join("")}</dl><h3>Training error per iteration</h3>${lossChart(report?.lossHistory)}${comparison}<details class="training-json"><summary>View metadata and JSON report</summary><pre>${trainingEscape(JSON.stringify({ metadata, trainingReport: report }, null, 2))}</pre></details>`;
}
async function loadTraining() {
  const revision = ++trainingLoadRevision;
  trainingLoadController?.abort();
  trainingLoadController = new AbortController();
  trainingState.loading = true;
  trainingElements["training-notice"].textContent = "Loading training runs…";
  renderTraining();
  try {
    const response = await fetch("/api/trained-models", { signal: trainingLoadController.signal, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load training runs.");
    if (!Array.isArray(data.iterations)) throw new Error("Invalid training history.");
    if (revision !== trainingLoadRevision) return;
    trainingState.iterations = data.iterations;
    if (!data.iterations.some((row) => row.id === trainingState.selectedId)) trainingState.selectedId = data.iterations.find((row) => row.active)?.id ?? data.iterations[0]?.id ?? null;
    trainingElements["training-notice"].textContent = data.iterations.length ? "Training history loaded. Refresh after a new training run." : "Train a model to create the first training run.";
  } catch (error) { if (revision === trainingLoadRevision && error.name !== "AbortError") trainingElements["training-notice"].textContent = error.message; }
  finally { if (revision === trainingLoadRevision) { trainingState.loading = false; renderTraining(); } }
}
trainingElements["training-list"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-iteration-id]");
  if (!button) return;
  trainingState.selectedId = button.dataset.iterationId;
  renderTraining();
});
trainingElements["reload-training"].addEventListener("click", loadTraining);
document.addEventListener("training-data-cleared", () => {
  ++trainingLoadRevision;
  trainingLoadController?.abort();
  trainingState.iterations = [];
  trainingState.selectedId = null;
  trainingState.loading = false;
  trainingElements["training-notice"].textContent = "Train a model to create the first training run.";
  renderTraining();
});
document.addEventListener("training-data-changed", loadTraining);
document.addEventListener("locale-changed", renderTraining);
loadTraining();
