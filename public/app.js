const state = {
  users: [], selectedId: null, query: "", sortBy: "name-asc", busy: false, loading: true,
  recommendationResult: null, recommendationLoading: false, recommendationError: "",
  editingId: null, startedPairs: new Set(),
  modelReady: null, modelId: null, trainingBusy: false,
};
const PAIR_MEMBER_COUNT = 2;
const SCORE_FRACTION_DIGITS = 1;
const RECOMMENDATION_SKELETON_COUNT = 5;
const DIVERSITY_SCALE = 100;
let recommendationRevision = 0;
let recommendationController = null;
const recommendationCache = new Map();
let cohortSignature = null;
const elements = Object.fromEntries([
  "student-list", "student-count", "selected-student", "recommendations", "notice",
  "search", "sort-students", "reload", "add-student", "student-dialog", "student-form", "form-error",
  "save-student", "form-heading", "close-dialog", "cancel-form", "recommendation-summary",
  "selection-placeholder", "selection-content",
].map((id) => [id, document.getElementById(id)]));

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const nameOf = (user) => user.name || window.i18n.t("Unnamed student");
const initials = (user) => nameOf(user).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const avatar = (user) => `<span class="avatar" aria-hidden="true">${escapeHtml(initials(user))}</span>`;
const scoreOf = (user) => Number(user.score);
const incomeAmountOf = (user) => {
  const raw = String(user.income ?? "").replace(/[^\d,.-]/g, "");
  if (!raw) return null;
  const amount = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  return Number.isFinite(amount) ? amount : null;
};
const incomeOf = (user) => {
  const amount = incomeAmountOf(user);
  return amount === null ? "Not provided" : new Intl.NumberFormat(window.i18n.locale, { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(amount);
};
const studentNameCollator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
const studentSorters = {
  "name-asc": (first, second) => studentNameCollator.compare(nameOf(first), nameOf(second)),
  "name-desc": (first, second) => studentNameCollator.compare(nameOf(second), nameOf(first)),
  "score-desc": (first, second) => scoreOf(second) - scoreOf(first),
  "score-asc": (first, second) => scoreOf(first) - scoreOf(second),
  "age-asc": (first, second) => Number(first.age) - Number(second.age),
  "age-desc": (first, second) => Number(second.age) - Number(first.age),
  "income-asc": (first, second) => compareIncome(first, second),
  "income-desc": (first, second) => compareIncome(first, second, true),
};

function compareIncome(first, second, descending = false) {
  const firstAmount = incomeAmountOf(first);
  const secondAmount = incomeAmountOf(second);
  if (firstAmount === null && secondAmount === null) return 0;
  if (firstAmount === null) return 1;
  if (secondAmount === null) return -1;
  return descending ? secondAmount - firstAmount : firstAmount - secondAmount;
}

function notify(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", error);
  elements.notice.hidden = !message;
}

function renderList() {
  const query = state.query.toLocaleLowerCase("pt-BR");
  const filtered = state.users.filter((user) => `${nameOf(user)} ${user.email}`.toLocaleLowerCase("pt-BR").includes(query));
  const compare = studentSorters[state.sortBy] ?? studentSorters["name-asc"];
  filtered.sort((first, second) => compare(first, second) || studentSorters["name-asc"](first, second) || first.id.localeCompare(second.id));
  elements["student-count"].textContent = query ? `${filtered.length} / ${state.users.length}` : String(state.users.length);
  elements["student-list"].setAttribute("aria-busy", String(state.loading));
  if (state.loading) {
    elements["student-list"].innerHTML = '<p class="empty">Loading students…</p>';
    return;
  }
  elements["student-list"].innerHTML = filtered.length ? filtered.map((user) => `
    <button class="student-row ${state.selectedId === user.id ? "selected" : ""}" data-user-id="${escapeHtml(user.id)}" aria-pressed="${state.selectedId === user.id}">
      ${avatar(user)}<span class="student-copy"><span class="student-name" data-i18n-skip>${escapeHtml(nameOf(user))}</span><span class="student-summary">Score ${escapeHtml(user.score)} · ${escapeHtml(user.age)} years${user.disability ? " · Has disability" : ""}</span></span>
    </button>`).join("") : `<p class="empty">${query ? "No students match this search." : "No students yet. Add a student to get started."}</p>`;
}

function pairKey(firstId, secondId) {
  return [firstId.toLowerCase(), secondId.toLowerCase()].sort().join(":");
}
function rememberStartedPair(outcome) {
  state.startedPairs.add(pairKey(outcome.userAId, outcome.userBId));
}
function hasStartedPair(userId, partnerId) {
  return state.startedPairs.has(pairKey(userId, partnerId));
}

function clearRecommendations() {
  recommendationRevision += 1;
  recommendationController?.abort();
  recommendationController = null;
  state.recommendationResult = null;
  state.recommendationLoading = false;
  state.recommendationError = "";
}

function invalidateRecommendations() {
  recommendationCache.clear();
  clearRecommendations();
}

async function loadSelectedRecommendations() {
  if (!state.selectedId || state.modelReady !== true || state.trainingBusy || state.busy || state.loading || state.recommendationLoading) return;
  const cached = recommendationCache.get(state.selectedId);
  if (cached && cached.modelId === state.modelId) {
    state.recommendationResult = structuredClone(cached.result);
    state.recommendationError = "";
    renderSelection();
    return;
  }
  await generateRecommendations();
}

function recommendationSkeletons() {
  return Array.from({ length: RECOMMENDATION_SKELETON_COUNT }, () => `
    <div class="recommendation recommendation-skeleton" aria-hidden="true">
      <span class="rank skeleton skeleton-rank"></span>
      <span class="avatar skeleton"></span>
      <div class="recommendation-info"><span class="skeleton skeleton-name"></span><span class="skeleton skeleton-description"></span></div>
      <div class="pair-mean"><span class="skeleton skeleton-label"></span><span class="skeleton skeleton-score"></span></div>
      <span class="start-pair skeleton skeleton-action"></span>
    </div>`).join("");
}

function renderSelection() {
  const selected = state.users.find((user) => user.id === state.selectedId);
  elements["selection-placeholder"].hidden = Boolean(selected);
  elements["selection-content"].hidden = !selected;
  elements.recommendations.setAttribute("aria-busy", String(state.recommendationLoading));
  elements["recommendation-summary"].textContent = "";
  if (!selected) {
    elements["selected-student"].innerHTML = "";
    elements.recommendations.innerHTML = "";
    return;
  }
  elements["selected-student"].innerHTML = `
    <div class="selected-header">${avatar(selected)}<div class="selected-copy"><h2 data-i18n-skip>${escapeHtml(nameOf(selected))}</h2><p class="email">${escapeHtml(selected.email)}</p></div><button class="delete-button" id="delete-student" ${state.busy || state.loading || state.recommendationLoading ? "disabled" : ""}>Delete student</button></div>
    <div class="metrics"><div><span class="metric-label">Exam score</span><span class="metric-value">${escapeHtml(selected.score)} <small>/ 100</small></span></div><div><span class="metric-label">Monthly income</span><span class="metric-value">${escapeHtml(incomeOf(selected))}</span></div><div><span class="metric-label">Profile</span><span class="metric-value">${selected.disability ? "Has disability" : "No disability"}</span></div></div>
    <div class="generate-actions"><button class="secondary" id="edit-student" ${state.busy || state.loading || state.recommendationLoading ? "disabled" : ""}>Edit student</button><button class="primary" id="generate-recommendations" ${state.busy || state.loading || state.recommendationLoading || state.modelReady !== true || state.trainingBusy ? "disabled" : ""}>${state.recommendationLoading ? "Loading recommendations…" : recommendationCache.has(selected.id) ? "Refresh recommendations" : "Generate recommendations"}</button></div>`;
  if (state.recommendationLoading) {
    elements["recommendation-summary"].textContent = "Loading recommendations…";
    elements.recommendations.innerHTML = recommendationSkeletons();
    return;
  }
  if (state.recommendationError && !state.recommendationResult) {
    elements.recommendations.innerHTML = `<p class="form-error" role="alert">${escapeHtml(state.recommendationError)}</p>`;
    return;
  }
  const result = state.recommendationResult;
  if (!result) {
    elements.recommendations.innerHTML = state.modelReady === false ? '<p class="empty">Model training required.</p>' : '<p class="empty">Waiting for recommendations…</p>';
    return;
  }
  const recommendationCount = result.recommendations.length;
  elements["recommendation-summary"].textContent = recommendationCount ? `${recommendationCount} ${recommendationCount === 1 ? "recommendation" : "recommendations"}${result.canStartPairs ? "" : " · Train a model to start study pairs."}` : "";
  if (state.recommendationError) elements["recommendation-summary"].textContent = "Could not refresh. Showing previous recommendations.";
  elements.recommendations.innerHTML = result.recommendations.length ? result.recommendations.map((pair, index) => {
    const user = pair.partner;
    const mean = (result.selectedScore + scoreOf(user)) / PAIR_MEMBER_COUNT;
    const canStart = result.canStartPairs && result.model && !pair.outcomeId && !hasStartedPair(result.userId, user.id);
    return `<article class="recommendation"><span class="rank">${index + 1}</span>${avatar(user)}<div class="recommendation-info"><h3 data-i18n-skip>${escapeHtml(nameOf(user))}</h3><p>Score ${escapeHtml(user.score)} · ${escapeHtml(incomeOf(user))}${user.disability ? " · Has disability" : ""}</p></div><div class="pair-mean"><span>Average score</span>${mean.toLocaleString(window.i18n.locale, { maximumFractionDigits: SCORE_FRACTION_DIGITS })}</div>${sociodiversityIndex(pair)}${canStart ? `<button class="secondary start-pair" data-partner-id="${escapeHtml(user.id)}" ${state.busy ? "disabled" : ""}>Start study pair</button>` : ""}</article>`;
  }).join("") : `<p class="empty">${result.evaluatedCount ? "No study pairs meet the criteria." : "Add another student."}</p>`;
}

function sociodiversityIndex(pair) {
  const distance = pair.metrics?.incomeDistance;
  if (!Number.isFinite(distance) || distance < 0 || distance > 1) return "";
  const diversity = distance * DIVERSITY_SCALE;
  const displayed = diversity.toLocaleString(window.i18n.locale, { maximumFractionDigits: SCORE_FRACTION_DIGITS });
  return `<div class="sociodiversity-index"><span>Sociodiversity index</span><strong data-i18n-skip>${displayed}</strong></div>`;
}

function render() {
  renderList();
  renderSelection();
  elements.reload.disabled = state.busy || state.loading || state.recommendationLoading;
  elements["add-student"].disabled = state.busy || state.loading || state.recommendationLoading;
  elements["save-student"].disabled = state.busy;
  elements["save-student"].textContent = state.busy ? "Saving…" : "Save student";
  elements["close-dialog"].disabled = state.busy;
  elements["cancel-form"].disabled = state.busy;
}

async function requestUsers(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => {
    throw new Error(window.i18n.t("The API returned an empty or invalid response (HTTP {status}). Check the Worker deployment.", { status: response.status }));
  });
  if (!response.ok) throw new Error(data.error || data.message || "Could not complete the operation. Please try again.");
  if (!Array.isArray(data.users)) throw new Error("The server returned an invalid student list.");
  return data.users;
}

function replaceUsers(users) {
  clearRecommendations();
  const signature = JSON.stringify(users.map((user) => [user.id, user.name, user.email, user.age, user.score, user.income, user.disability])
    .sort((first, second) => first[0].localeCompare(second[0])));
  if (signature !== cohortSignature) recommendationCache.clear();
  cohortSignature = signature;
  state.users = users;
  if (!users.some((user) => user.id === state.selectedId)) state.selectedId = null;
}

async function loadUsers() {
  clearRecommendations();
  state.loading = true;
  notify("");
  render();
  try {
    replaceUsers(await requestUsers("/api/users"));
  } catch (error) {
    notify(error.message, true);
  } finally {
    state.loading = false;
    render();
    await loadSelectedRecommendations();
  }
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderList();
});
elements["sort-students"].addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  renderList();
});
elements["student-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-id]");
  if (!button || state.busy) return;
  if (state.selectedId !== button.dataset.userId) {
    clearRecommendations();
    state.selectedId = button.dataset.userId;
    render();
  }
  await loadSelectedRecommendations();
});
elements.reload.addEventListener("click", loadUsers);
elements["add-student"].addEventListener("click", () => {
  state.editingId = null;
  elements["form-heading"].textContent = "Add student";
  elements["student-form"].reset();
  elements["form-error"].hidden = true;
  elements["student-dialog"].showModal();
});
for (const id of ["close-dialog", "cancel-form"]) {
  elements[id].addEventListener("click", () => elements["student-dialog"].close());
}
elements["student-dialog"].addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});

elements["student-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const fields = new FormData(event.target);
  const payload = {
    name: fields.get("name").trim(), email: fields.get("email").trim(),
    age: Number(fields.get("age")), score: Number(fields.get("score")),
    income: String(fields.get("income")), disability: fields.has("disability"),
  };
  state.busy = true;
  elements["form-error"].hidden = true;
  render();
  try {
    const editingId = state.editingId;
    replaceUsers(await requestUsers(editingId ? `/api/users/${encodeURIComponent(editingId)}` : "/api/users", {
      method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }));
    state.selectedId = state.users.find((user) => user.email === payload.email)?.id ?? state.selectedId;
    state.query = "";
    elements.search.value = "";
    elements["student-dialog"].close();
    notify(`${payload.name} ${editingId ? "was updated" : "was added to the cohort"}.`);
    state.editingId = null;
  } catch (error) {
    elements["form-error"].textContent = error.message;
    elements["form-error"].hidden = false;
  } finally {
    state.busy = false;
    render();
    await loadSelectedRecommendations();
  }
});

elements["selected-student"].addEventListener("click", async (event) => {
  if (event.target.closest("#edit-student")) {
    if (state.busy || state.loading || state.recommendationLoading) return;
    const user = state.users.find((candidate) => candidate.id === state.selectedId);
    if (!user) return;
    state.editingId = user.id;
    elements["form-heading"].textContent = "Edit student";
    const form = elements["student-form"];
    for (const name of ["name", "email", "age", "score"]) form.elements.namedItem(name).value = user[name];
    const rawIncome = String(user.income ?? "").replace(/[^\d,.-]/g, "");
    form.elements.namedItem("income").value = Number(rawIncome.includes(",") ? rawIncome.replace(/\./g, "").replace(",", ".") : rawIncome);
    form.elements.namedItem("disability").checked = user.disability;
    elements["form-error"].hidden = true;
    elements["student-dialog"].showModal();
    return;
  }
  if (event.target.closest("#generate-recommendations")) {
    await generateRecommendations();
    return;
  }
  if (!event.target.closest("#delete-student") || state.busy || state.loading || state.recommendationLoading) return;
  const selected = state.users.find((user) => user.id === state.selectedId);
  if (!selected || !window.confirm(window.i18n.t(`Delete ${nameOf(selected)}? The student and their study pair records will be removed from the database.`))) return;
  state.busy = true;
  render();
  try {
    replaceUsers(await requestUsers(`/api/users/${encodeURIComponent(selected.id)}`, { method: "DELETE" }));
    notify(`${nameOf(selected)} was removed from the cohort.`);
  } catch (error) {
    notify(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
});

async function generateRecommendations() {
  const userId = state.selectedId;
  if (!userId || state.busy || state.loading || state.recommendationLoading || state.modelReady === false || state.trainingBusy) return;
  clearRecommendations();
  const revision = recommendationRevision;
  recommendationController = new AbortController();
  state.recommendationLoading = true;
  render();
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/recommendations`, {
      method: "POST", signal: recommendationController.signal,
    });
    let data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not generate recommendations.");
    if (data.inference) data = await window.rankRecommendations(data, recommendationController.signal);
    if (data.userId !== userId || !Array.isArray(data.recommendations) || !Number.isFinite(data.selectedScore) || !Number.isFinite(data.cohortMeanScore)) {
      throw new Error("The server returned invalid recommendations.");
    }
    // Uma resposta atrasada não pode substituir os resultados da nova seleção.
    if (revision !== recommendationRevision || state.selectedId !== userId) return;
    state.recommendationResult = data;
    recommendationCache.set(userId, { modelId: data.model?.modelId ?? null, result: structuredClone(data) });
  } catch (error) {
    if (revision !== recommendationRevision || error.name === "AbortError") return;
    const cached = recommendationCache.get(userId);
    state.recommendationResult = cached?.modelId === state.modelId ? structuredClone(cached.result) : null;
    state.recommendationError = error.message;
  } finally {
    if (revision === recommendationRevision) {
      state.recommendationLoading = false;
      recommendationController = null;
      render();
    }
  }
}

document.addEventListener("training-model-status", async (event) => {
  const { modelReady, modelId, training } = event.detail;
  const trainingBusy = ["running", "clearing"].includes(training.status);
  const modelChanged = state.modelReady !== null && state.modelId !== modelId;
  const finishedTraining = state.trainingBusy && training.status === "completed";
  const availabilityChanged = state.modelReady !== modelReady || state.trainingBusy !== trainingBusy || modelChanged;
  state.modelReady = modelReady;
  state.modelId = modelId;
  state.trainingBusy = trainingBusy;
  if (!modelReady || modelChanged || finishedTraining) invalidateRecommendations();
  // Progresso por iteração não precisa reconstruir a lista nem tirar o foco do usuário.
  if (availabilityChanged) render();
  if (finishedTraining && modelReady) notify("Model trained. Recommendations are available.");
  if (modelReady && !trainingBusy && state.selectedId && availabilityChanged) await loadSelectedRecommendations();
});

document.addEventListener("locale-changed", render);
loadUsers();
