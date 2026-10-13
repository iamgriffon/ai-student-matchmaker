(() => {
  const PERCENT_SCALE = 100;
  const HISTORY_DATE_OPTIONS = { dateStyle: "short", timeStyle: "short" };
  const list = document.getElementById("outcome-list");
  const notice = document.getElementById("outcome-notice");
  const dialog = document.getElementById("outcome-dialog");
  const form = document.getElementById("outcome-form");
  const formError = document.getElementById("outcome-form-error");
  let outcomes = [];
  let activeOutcome = null;
  let historyRevision = 0;
  let saving = false;
  let lastModelId;

  const memberName = (id) => nameOf(state.users.find((user) => user.id === id) ?? { name: id });
  const dateText = (value) => new Date(value).toLocaleString(window.i18n.locale, HISTORY_DATE_OPTIONS);
  async function request(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save study pair data.");
    return data;
  }
  function renderHistory() {
    list.innerHTML = outcomes.length ? outcomes.map((row) => {
      const members = `${memberName(row.userAId)} + ${memberName(row.userBId)}`;
      const result = row.completedAt
        ? `<p>Scores: ${row.scoreBeforeA} → ${row.scoreAfterA} / ${row.scoreBeforeB} → ${row.scoreAfterB}</p><p>Participation: ${row.participationA * PERCENT_SCALE}% / ${row.participationB * PERCENT_SCALE}% · Feedback: ${row.feedbackA}/5 / ${row.feedbackB}/5</p><p>Outcomes recorded on ${escapeHtml(dateText(row.completedAt))}</p>`
        : `<p>Initial scores: ${row.scoreBeforeA} / ${row.scoreBeforeB}</p><button class="secondary" data-outcome-id="${escapeHtml(row.id)}" ${state.busy ? "disabled" : ""}>Record outcomes</button>`;
      const modelBadge = row.modelOutdated ? '<span class="outdated-model-badge">Outdated model</span>' : "";
      return `<article class="outcome-card"><div class="outcome-heading"><h3 data-i18n-skip>${escapeHtml(members)}</h3>${modelBadge}</div><p>Started on ${escapeHtml(dateText(row.startedAt))}</p>${result}${row.notes ? `<p data-i18n-skip>${escapeHtml(row.notes)}</p>` : ""}</article>`;
    }).join("") : '<p class="empty">No study pairs started.</p>';
  }
  async function loadHistory() {
    const selectedId = state.selectedId;
    const revision = ++historyRevision;
    outcomes = [];
    if (!selectedId) {
      list.innerHTML = '<p class="empty">No study pairs started.</p>';
      return;
    }
    list.innerHTML = '<p class="empty">Loading study pairs…</p>';
    try {
      const data = await request(`/api/pair-outcomes?userId=${encodeURIComponent(selectedId)}`);
      if (revision !== historyRevision || selectedId !== state.selectedId) return;
      if (!Array.isArray(data.outcomes)) throw new Error("Invalid study pair history.");
      outcomes = data.outcomes;
      for (const outcome of outcomes) rememberStartedPair(outcome);
      render();
      renderHistory();
    } catch (error) {
      if (revision !== historyRevision || selectedId !== state.selectedId) return;
      list.innerHTML = `<p class="form-error" role="alert">${escapeHtml(error.message)}</p>`;
    }
  }
  document.addEventListener("locale-changed", renderHistory);
  document.getElementById("reload-outcomes").addEventListener("click", loadHistory);
  document.addEventListener("training-model-status", (event) => {
    const modelId = event.detail.modelId;
    if (typeof modelId == 'undefined') return;
    const changed = typeof lastModelId != 'undefined' && lastModelId !== modelId;
    lastModelId = modelId;
    if (changed && state.selectedId) loadHistory();
  });
  elements["student-list"].addEventListener("click", (event) => {
    if (event.target.closest("[data-user-id]") && !state.busy) {
      notice.textContent = "";
      loadHistory();
    }
  });
  elements.recommendations.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-partner-id]");
    const recommendation = state.recommendationResult;
    if (!button || !recommendation?.canStartPairs || !recommendation.model || state.busy || state.recommendationLoading || hasStartedPair(recommendation.userId, button.dataset.partnerId)) return;
    state.busy = true;
    render();
    notice.textContent = "Starting study pair…";
    try {
      const data = await request("/api/pair-outcomes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAId: recommendation.userId, userBId: button.dataset.partnerId,
          contextVersion: recommendation.contextVersion, modelId: recommendation.model?.modelId ?? null,
        }),
      });
      rememberStartedPair(data.outcome);
      render();
      notice.textContent = data.created ? "Study pair started." : "Study pair already started.";
      await loadHistory();
    } catch (error) { notice.textContent = error.message; }
    finally { state.busy = false; render(); renderHistory(); }
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-outcome-id]");
    if (!button || state.busy) return;
    activeOutcome = outcomes.find((row) => row.id === button.dataset.outcomeId);
    if (!activeOutcome || activeOutcome.completedAt) return;
    form.reset();
    formError.hidden = true;
    document.getElementById("outcome-member-a").textContent = `${memberName(activeOutcome.userAId)} · initial score ${activeOutcome.scoreBeforeA}`;
    document.getElementById("outcome-member-b").textContent = `${memberName(activeOutcome.userBId)} · initial score ${activeOutcome.scoreBeforeB}`;
    dialog.showModal();
  });
  document.getElementById("close-outcome").addEventListener("click", () => { if (!saving) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeOutcome || saving || state.busy) return;
    const fields = new FormData(form);
    const payload = {
      scoreAfterA: Number(fields.get("scoreAfterA")), scoreAfterB: Number(fields.get("scoreAfterB")),
      participationA: Number(fields.get("participationA")) / PERCENT_SCALE,
      participationB: Number(fields.get("participationB")) / PERCENT_SCALE,
      feedbackA: Number(fields.get("feedbackA")), feedbackB: Number(fields.get("feedbackB")),
      notes: String(fields.get("notes") ?? ""),
    };
    saving = true;
    state.busy = true;
    render();
    document.getElementById("save-outcome").disabled = true;
    formError.hidden = true;
    try {
      await request(`/api/pair-outcomes/${encodeURIComponent(activeOutcome.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      dialog.close();
      notice.textContent = "Outcomes saved.";
      await loadHistory();
    } catch (error) { formError.textContent = error.message; formError.hidden = false; }
    finally {
      saving = false;
      state.busy = false;
      document.getElementById("save-outcome").disabled = false;
      render();
      renderHistory();
    }
  });
})();
