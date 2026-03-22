const state = {
  health: null,
  workspaces: [],
  workspace: null,
  workspaceId: window.localStorage.getItem("proposal-helmsman.workspace") || "",
  loading: {
    boot: true,
    workspaces: false,
    workspace: false,
    operator: false
  },
  activity: [],
  selectedSection: "Executive Summary",
  optimistic: {
    sectionName: "",
    sectionContent: "",
    proposalContent: ""
  },
  ui: {
    modalReturnFocus: null
  }
};

const elements = {};
const dashboardLockIds = [
  "new-workspace-button",
  "confirm-create-button",
  "workspace-name-input",
  "rfp-input",
  "load-sample-button",
  "parse-button",
  "plan-button",
  "refresh-button",
  "coverage-button",
  "section-select",
  "emphasis-input",
  "draft-button",
  "revision-input",
  "revise-button",
  "download-export-button",
  "export-button",
  "focus-popover-toggle",
  "reset-button"
];

class RequestError extends Error {
  constructor(
    message,
    { status = 0, code = "REQUEST_ERROR", details = undefined, retryable = false, reasons = [] } = {},
  ) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.reasons = reasons;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  captureElements();
  bindEvents();
  void boot();
});

async function boot() {
  renderLoadingState();
  state.loading.boot = true;

  try {
    await Promise.allSettled([loadHealth(), loadSampleRfp(), refreshWorkspaces()]);

    if (!state.workspaceId) {
      await createWorkspace("proposal-thread");
    } else {
      await refreshWorkspace();
    }
  } catch (error) {
    reportUiError(error, {
      fallback: "Proposal Helmsman could not finish booting.",
      toastMessage: "Startup failed.",
      logTitle: "Boot failed"
    });
  } finally {
    state.loading.boot = false;
    render();
  }
}

function captureElements() {
  const ids = [
    "workspace-list",
    "workspace-create-panel",
    "workspace-name-input",
    "confirm-create-button",
    "model-badge",
    "guardrail-badge",
    "hero-workspace",
    "hero-mode",
    "hero-updated",
    "notice-bar",
    "trust-note",
    "rfp-input",
    "load-sample-button",
    "parse-button",
    "plan-button",
    "refresh-button",
    "pulse-panel",
    "activity-log",
    "coverage-button",
    "coverage-summary",
    "requirements-list",
    "section-list",
    "section-select",
    "emphasis-input",
    "draft-button",
    "revision-input",
    "revise-button",
    "section-preview",
    "download-export-button",
    "export-button",
    "proposal-preview",
    "new-workspace-button",
    "focus-popover-toggle",
    "focus-popover",
    "reset-button",
    "modal-backdrop",
    "cancel-reset-button",
    "confirm-reset-button",
    "toast-region"
  ];

  for (const id of ids) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements["new-workspace-button"].addEventListener("click", async () => {
    const isHidden = elements["workspace-create-panel"].classList.contains("hidden");
    toggleWorkspaceCreatePanel(isHidden);
  });

  elements["confirm-create-button"].addEventListener("click", async () => {
    await submitWorkspaceCreate();
  });

  elements["workspace-name-input"].addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await submitWorkspaceCreate();
    }
  });

  elements["load-sample-button"].addEventListener("click", async () => {
    setBusy(elements["load-sample-button"], true, {
      busyLabel: "Loading..."
    });

    try {
      await loadSampleRfp(true);
    } finally {
      setBusy(elements["load-sample-button"], false);
    }
  });

  elements["parse-button"].addEventListener("click", async () => {
    await runParse();
  });

  elements["plan-button"].addEventListener("click", async () => {
    await sendOperatorMessage("/plan", {
      button: elements["plan-button"],
      busyLabel: "Planning...",
      success: "Proposal structure replanned."
    });
  });

  elements["refresh-button"].addEventListener("click", async () => {
    await refreshWorkspace({
      announce: true,
      button: elements["refresh-button"],
      busyLabel: "Refreshing..."
    });
  });

  elements["coverage-button"].addEventListener("click", async () => {
    await sendOperatorMessage("/coverage", {
      button: elements["coverage-button"],
      busyLabel: "Updating...",
      success: "Requirement coverage updated."
    });
  });

  elements["draft-button"].addEventListener("click", async () => {
    await runDraft();
  });

  elements["revise-button"].addEventListener("click", async () => {
    await runRevision();
  });

  elements["export-button"].addEventListener("click", async () => {
    await runExport();
  });

  elements["download-export-button"].addEventListener("click", async () => {
    await runDownload();
  });

  elements["section-select"].addEventListener("change", (event) => {
    state.selectedSection = event.target.value;
    render();
  });

  elements["rfp-input"].addEventListener("keydown", async (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      await runParse();
    }
  });

  elements["revision-input"].addEventListener("keydown", async (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      await runRevision();
    }
  });

  elements["focus-popover-toggle"].addEventListener("click", () => {
    const isHidden = elements["focus-popover"].classList.contains("hidden");
    toggleFocusPopover(isHidden);
  });

  elements["focus-popover"].addEventListener("click", (event) => {
    const target = event.target.closest("[data-emphasis]");

    if (!target) {
      return;
    }

    elements["emphasis-input"].value = target.dataset.emphasis;
    toggleFocusPopover(false);
    toast("Emphasis preset applied.");
  });

  elements["reset-button"].addEventListener("click", () => {
    openResetModal();
  });

  elements["cancel-reset-button"].addEventListener("click", () => {
    closeResetModal();
  });

  elements["confirm-reset-button"].addEventListener("click", async () => {
    await resetWorkspace();
  });

  elements["modal-backdrop"].addEventListener("click", (event) => {
    if (event.target === elements["modal-backdrop"]) {
      closeResetModal();
    }
  });

  for (const id of ["workspace-list", "activity-log", "coverage-summary", "section-list"]) {
    elements[id].addEventListener("click", async (event) => {
      const actionButton = event.target.closest("[data-empty-action]");

      if (!actionButton) {
        return;
      }

      await runEmptyAction(actionButton.dataset.emptyAction, actionButton);
    });
  }

  window.addEventListener("click", (event) => {
    if (
      !elements["focus-popover"].contains(event.target) &&
      event.target !== elements["focus-popover-toggle"]
    ) {
      toggleFocusPopover(false);
    }

    if (
      !elements["workspace-create-panel"].contains(event.target) &&
      event.target !== elements["new-workspace-button"]
    ) {
      toggleWorkspaceCreatePanel(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      toggleFocusPopover(false);
      toggleWorkspaceCreatePanel(false);
      closeResetModal();
      return;
    }

    if (event.key === "Tab" && isResetModalOpen()) {
      trapResetModalFocus(event);
    }
  });
}

async function loadHealth() {
  try {
    state.health = await fetchJson("/api/health");
  } catch (error) {
    state.health = {
      model: {
        model: "Unavailable",
        mode: "demo"
      },
      civic: {
        mockMode: true,
        configured: false
      }
    };
    reportUiError(error, {
      fallback: "Health check failed. The UI is running in degraded mode.",
      showToast: false,
      logTitle: "Health check failed"
    });
  } finally {
    render();
  }
}

async function loadSampleRfp(force = false) {
  try {
    const sample = await fetchJson("/api/sample-rfp");

    if (force || !elements["rfp-input"].value.trim()) {
      elements["rfp-input"].value = sample.rfpText;
      toast("Sample RFP loaded.");
    }
  } catch (error) {
    reportUiError(error, {
      fallback: "Sample RFP could not be loaded.",
      showToast: force,
      notice: force,
      logTitle: "Sample load failed"
    });
  }
}

async function refreshWorkspaces() {
  state.loading.workspaces = true;
  render();

  try {
    const data = await fetchJson("/api/workspaces");
    state.workspaces = data.workspaces;
  } catch (error) {
    reportUiError(error, {
      fallback: "Workspace list could not be refreshed.",
      showToast: false,
      logTitle: "Workspace refresh failed"
    });
  } finally {
    state.loading.workspaces = false;
    render();
  }
}

async function createWorkspace(label, options = {}) {
  setBusy(options.button, true, {
    busyLabel: options.busyLabel || "Creating..."
  });

  try {
    const data = await fetchJson("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        workspaceLabel: label
      })
    });

    state.workspaceId = data.workspaceId;
    window.localStorage.setItem("proposal-helmsman.workspace", state.workspaceId);
    state.workspace = data.workspace;
    state.selectedSection = "Executive Summary";
    toggleWorkspaceCreatePanel(false);
    clearNotice();
    logActivity("Workspace created", label);
    await refreshWorkspaces();
    render();
    toast("Workspace created.");
    return data.workspace;
  } catch (error) {
    reportUiError(error, {
      fallback: "Workspace could not be created.",
      logTitle: "Workspace creation failed"
    });
    return undefined;
  } finally {
    setBusy(options.button, false);
  }
}

async function refreshWorkspace(options = {}) {
  if (!state.workspaceId) {
    return;
  }

  state.loading.workspace = true;
  setBusy(options.button, true, {
    busyLabel: options.busyLabel
  });
  render();

  try {
    const data = await fetchJson(`/api/status?workspaceId=${encodeURIComponent(state.workspaceId)}`);
    state.workspace = data.workspace;
    syncSectionSelection();
    if (options.announce) {
      toast("Workspace refreshed.");
    }
  } catch (error) {
    reportUiError(error, {
      fallback: "Workspace status could not be loaded.",
      showToast: Boolean(options.announce),
      notice: true,
      logTitle: "Workspace load failed"
    });
  } finally {
    state.loading.workspace = false;
    setBusy(options.button, false);
    render();
  }
}

async function sendOperatorMessage(message, options = {}) {
  if (!state.workspaceId) {
    return;
  }

  if (state.loading.operator) {
    notifyOperatorBusy();
    return undefined;
  }

  state.loading.operator = true;
  setDashboardInteractionLocked(true, options.button);
  setBusy(options.button, true, {
    busyLabel: options.busyLabel
  });
  clearNotice();

  try {
    const data = await fetchJson("/api/message", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: state.workspaceId,
        message
      })
    });

    state.workspace = data.workspace;
    state.workspaces = data.workspaces;
    syncSectionSelection();
    resetOptimisticState();

    if (data.agentResult.status === "blocked") {
      showNotice(data.agentResult.reason.join(" "), "error");
      logActivity("Blocked", data.agentResult.message);
      toast("Guardrails blocked that action.", "error");
      render();
      return data;
    }

    if (data.agentResult.guardrail?.modified) {
      showNotice(formatGuardrailNotice(data.agentResult.guardrail), "info");
      toast("Saved with guardrail changes.");
    } else if (options.success) {
      toast(options.success);
    }

    logActivity(data.agentResult.action, data.agentResult.message);
    render();
    return data;
  } catch (error) {
    resetOptimisticState();
    reportUiError(error, {
      fallback: "The operator request failed.",
      logTitle: "Operator error"
    });
    render();
    return undefined;
  } finally {
    setBusy(options.button, false);
    state.loading.operator = false;
    setDashboardInteractionLocked(false);
  }
}

async function runParse() {
  if (state.loading.operator) {
    notifyOperatorBusy();
    return;
  }

  const rfpText = elements["rfp-input"].value.trim();

  if (!rfpText) {
    showNotice("Paste RFP text before parsing.", "error");
    return;
  }

  await sendOperatorMessage(`/parse ${rfpText}`, {
    button: elements["parse-button"],
    busyLabel: "Parsing...",
    success: "RFP parsed."
  });
}

async function runDraft() {
  if (state.loading.operator) {
    notifyOperatorBusy();
    return;
  }

  const sectionName = elements["section-select"].value || state.selectedSection;
  const emphasis = elements["emphasis-input"].value.trim();
  state.selectedSection = sectionName;
  state.optimistic.sectionName = sectionName;
  state.optimistic.sectionContent = "Drafting section with guardrails and requirement context...";
  render();

  const suffix = emphasis ? `::${emphasis}` : "";
  await sendOperatorMessage(`/draft ${sectionName}${suffix}`, {
    button: elements["draft-button"],
    busyLabel: "Drafting...",
    success: `${sectionName} drafted.`
  });
}

async function runRevision() {
  if (state.loading.operator) {
    notifyOperatorBusy();
    return;
  }

  const sectionName = elements["section-select"].value || state.selectedSection;
  const instruction = elements["revision-input"].value.trim();

  if (!instruction) {
    showNotice("Write a revision instruction first.", "error");
    return;
  }

  state.selectedSection = sectionName;
  state.optimistic.sectionName = sectionName;
  state.optimistic.sectionContent = "Applying revision safely...";
  render();

  await sendOperatorMessage(`/revise ${sectionName}::${instruction}`, {
    button: elements["revise-button"],
    busyLabel: "Revising...",
    success: `${sectionName} revised.`
  });
}

async function runExport() {
  if (state.loading.operator) {
    notifyOperatorBusy();
    return;
  }

  state.optimistic.proposalContent = "Assembling proposal draft...";
  render();

  await sendOperatorMessage("/export", {
    button: elements["export-button"],
    busyLabel: "Exporting...",
    success: "Proposal exported."
  });
}

async function runDownload() {
  if (state.loading.operator) {
    notifyOperatorBusy();
    return;
  }

  if (!state.workspaceId) {
    showNotice("Create or select a workspace before downloading.", "error");
    return;
  }

  setBusy(elements["download-export-button"], true, {
    busyLabel: "Downloading..."
  });
  clearNotice();

  try {
    const response = await window.fetch(
      `/api/proposal?workspaceId=${encodeURIComponent(state.workspaceId)}`,
    );

    if (!response.ok) {
      const payload = await parseResponsePayload(response);
      throw toRequestError(response.status, payload);
    }

    const blob = await response.blob();
    const fileName =
      parseDownloadFileName(response.headers.get("content-disposition")) ||
      `${state.workspaceId}-proposal.md`;
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => {
      window.URL.revokeObjectURL(objectUrl);
    }, 0);

    toast("Proposal downloaded.");
    logActivity("Proposal downloaded", fileName);
  } catch (error) {
    reportUiError(error, {
      fallback: "Proposal download failed.",
      logTitle: "Proposal download failed"
    });
  } finally {
    setBusy(elements["download-export-button"], false);
  }
}

async function resetWorkspace() {
  if (!state.workspaceId) {
    return;
  }

  setBusy(elements["confirm-reset-button"], true, {
    busyLabel: "Resetting..."
  });

  try {
    const data = await fetchJson("/api/reset", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: state.workspaceId
      })
    });

    state.workspace = data.workspace;
    state.optimistic = {
      sectionName: "",
      sectionContent: "",
      proposalContent: ""
    };
    closeResetModal();
    elements["revision-input"].value = "";
    elements["emphasis-input"].value = "";
    await refreshWorkspaces();
    render();
    toast("Workspace reset.");
    logActivity("Workspace reset", state.workspaceId);
  } catch (error) {
    reportUiError(error, {
      fallback: "Workspace reset failed.",
      logTitle: "Workspace reset failed"
    });
  } finally {
    setBusy(elements["confirm-reset-button"], false);
  }
}

function render() {
  renderHeader();
  renderSidebar();
  renderNotice();
  renderPulse();
  renderCoverage();
  renderSections();
  renderSectionPreview();
  renderProposalPreview();
  renderTrust();
}

function renderLoadingState() {
  elements["pulse-panel"].innerHTML = skeletonLines(3);
  elements["requirements-list"].innerHTML = skeletonLines(4);
  elements["section-list"].innerHTML = skeletonLines(4);
  elements["section-preview"].textContent = "Loading workspace...";
  elements["proposal-preview"].textContent = "Proposal preview will appear here.";
}

function renderHeader() {
  elements["model-badge"].textContent = state.health
    ? `${state.health.model.model} · ${state.health.model.mode}`
    : "Loading...";
  elements["guardrail-badge"].textContent = state.health
    ? state.health.civic.mockMode
      ? "Mock guardrails"
      : "Live Civic"
    : "Loading...";

  elements["hero-workspace"].textContent = state.workspaceId || "Starting";
  elements["hero-mode"].textContent = state.health
    ? state.health.model.mode === "live"
      ? "Live model"
      : "Demo model"
    : "Loading";
  elements["hero-updated"].textContent = state.workspace?.updatedAt
    ? formatTime(state.workspace.updatedAt)
    : "Waiting";
}

function renderTrust() {
  if (!state.health) {
    elements["trust-note"].dataset.mode = "loading";
    elements["trust-note"].innerHTML =
      '<span class="trust-state state-loading">Checking</span><strong>Loading trust posture...</strong><small>Checking model and guardrail configuration.</small>';
    return;
  }

  const isMock = state.health.civic.mockMode;
  const modelMode = state.health.model.mode;
  elements["trust-note"].dataset.mode = isMock ? "mock" : "live";
  elements["guardrail-badge"].dataset.mode = isMock ? "mock" : "live";
  elements["hero-mode"].dataset.mode = modelMode;

  elements["trust-note"].innerHTML = isMock
    ? `<span class="trust-state state-mock">Demo guardrails</span><strong>Demo guardrails active</strong><small>Civic is running in mock mode, so this environment is safe for demos but not a production trust signal.</small>`
    : `<span class="trust-state state-live">Live guardrails</span><strong>Live guardrails active</strong><small>${escapeHtml(
        state.health.model.model,
      )} is running in ${escapeHtml(modelMode)} mode with Civic endpoints configured.</small>`;
}

function renderSidebar() {
  if (state.loading.workspaces) {
    elements["workspace-list"].innerHTML = skeletonLines(3);
    return;
  }

  if (state.workspaces.length === 0) {
    elements["workspace-list"].innerHTML =
      emptyStatePanel({
        title: "No workspaces yet",
        detail: "Create one to start an auditable thread.",
        actionLabel: "Create workspace",
        actionId: "create-workspace"
      });
    return;
  }

  elements["workspace-list"].innerHTML = state.workspaces
    .map((workspace) => {
      const coverage =
        workspace.totalMustHave > 0
          ? `${workspace.coveredMustHave}/${workspace.totalMustHave} must-have`
          : "No must-haves yet";

      return `
        <button class="workspace-button ${workspace.id === state.workspaceId ? "active" : ""}" data-workspace-id="${workspace.id}" type="button">
          <strong>${escapeHtml(workspace.id)}</strong>
          <small>${escapeHtml(workspace.summary || "Awaiting RFP intake.")}</small>
          <small>${escapeHtml(coverage)}</small>
        </button>
      `;
    })
    .join("");

  for (const button of elements["workspace-list"].querySelectorAll("[data-workspace-id]")) {
    button.addEventListener("click", async () => {
      state.workspaceId = button.dataset.workspaceId;
      window.localStorage.setItem("proposal-helmsman.workspace", state.workspaceId);
      await refreshWorkspace({
        announce: true,
        button,
        busyLabel: "Loading..."
      });
      render();
    });
  }
}

function renderNotice() {
  if (!elements["notice-bar"].dataset.message) {
    elements["notice-bar"].classList.add("hidden");
    return;
  }

  elements["notice-bar"].textContent = elements["notice-bar"].dataset.message;
  elements["notice-bar"].setAttribute(
    "role",
    elements["notice-bar"].dataset.kind === "error" ? "alert" : "status",
  );
  elements["notice-bar"].classList.toggle(
    "error",
    elements["notice-bar"].dataset.kind === "error",
  );
  elements["notice-bar"].classList.remove("hidden");
}

function renderPulse() {
  if (state.loading.workspace) {
    elements["pulse-panel"].innerHTML = skeletonLines(3);
    elements["activity-log"].innerHTML = skeletonLines(2);
    return;
  }

  const coverage = state.workspace?.coverage ?? {
    requirementCount: 0,
    coveredCount: 0,
    mustHaveTotal: 0,
    mustHaveCovered: 0
  };

  const metrics = [
    {
      label: "Requirements",
      value: coverage.requirementCount
    },
    {
      label: "Sections drafted",
      value: state.workspace?.sections.filter((section) => section.exists).length ?? 0
    },
    {
      label: "Must-have covered",
      value:
        coverage.mustHaveTotal > 0
          ? `${coverage.mustHaveCovered}/${coverage.mustHaveTotal}`
          : "0"
    }
  ];

  elements["pulse-panel"].innerHTML = metrics
    .map(
      (metric) => `
        <div class="metric">
          <span class="mini-label">${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(String(metric.value))}</strong>
        </div>
      `,
    )
    .join("");

  if (state.activity.length === 0) {
    const pulseAction = elements["rfp-input"].value.trim()
      ? {
          actionLabel: "Parse RFP",
          actionId: "parse-rfp"
        }
      : {
          actionLabel: "Load sample RFP",
          actionId: "load-sample"
        };
    elements["activity-log"].innerHTML =
      emptyStatePanel({
        title: "Operator trail is quiet",
        detail: "Run parse, draft, revise, or export to create a visible activity log.",
        ...pulseAction
      });
    return;
  }

  elements["activity-log"].innerHTML = state.activity
    .slice(0, 6)
    .map(
      (item) => `
        <div class="activity-item">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.detail)}</small>
          <small>${escapeHtml(item.at)}</small>
        </div>
      `,
    )
    .join("");
}

function renderCoverage() {
  if (state.loading.workspace) {
    elements["coverage-summary"].innerHTML = skeletonLines(2);
    elements["requirements-list"].innerHTML = skeletonLines(5);
    return;
  }

  const coverage = state.workspace?.coverage;

  if (!state.workspace?.hasRfp) {
    elements["coverage-summary"].innerHTML =
      emptyStatePanel(
        elements["rfp-input"].value.trim()
          ? {
              title: "Coverage is waiting",
              detail: "Parse the current RFP text to start tracking requirement coverage.",
              actionLabel: "Parse RFP",
              actionId: "parse-rfp"
            }
          : {
              title: "Coverage is waiting",
              detail: "Load a sample or paste an RFP to start tracking requirement coverage.",
              actionLabel: "Load sample RFP",
              actionId: "load-sample"
            },
      );
    elements["requirements-list"].innerHTML = "";
    return;
  }

  const percent =
    coverage.requirementCount > 0
      ? Math.round((coverage.coveredCount / coverage.requirementCount) * 100)
      : 0;
  const mustPercent =
    coverage.mustHaveTotal > 0
      ? Math.round((coverage.mustHaveCovered / coverage.mustHaveTotal) * 100)
      : 0;

  elements["coverage-summary"].innerHTML = `
    <div>
      <div class="workspace-row">
        <strong>${percent}% overall coverage</strong>
        <span class="badge ${percent > 65 ? "covered" : "pending"}">${coverage.coveredCount}/${coverage.requirementCount}</span>
      </div>
      <div class="coverage-bar"><span style="width:${percent}%"></span></div>
    </div>
    <div>
      <div class="workspace-row">
        <strong>${mustPercent}% must-have coverage</strong>
        <span class="badge ${mustPercent > 65 ? "covered" : "pending"}">${coverage.mustHaveCovered}/${coverage.mustHaveTotal}</span>
      </div>
      <div class="coverage-bar"><span style="width:${mustPercent}%"></span></div>
    </div>
  `;

  elements["requirements-list"].innerHTML = state.workspace.requirements
    .map(
      (requirement) => `
        <div class="requirement-item">
          <div class="requirement-top">
            <strong>${escapeHtml(requirement.id)}</strong>
            <span class="badge ${
              requirement.covered ? "covered" : requirement.must_have ? "danger" : "pending"
            }">${requirement.covered ? "Covered" : requirement.must_have ? "Must have" : "Pending"}</span>
          </div>
          <div>${escapeHtml(requirement.text)}</div>
          ${
            Array.isArray(requirement.evidence) && requirement.evidence.length > 0
              ? `
                <div class="requirement-evidence-list">
                  ${requirement.evidence
                    .map(
                      (evidence) => `
                        <div class="requirement-evidence">
                          <strong>${escapeHtml(evidence.section)}</strong>
                          <span>${escapeHtml(evidence.file)}</span>
                          <small>${escapeHtml(evidence.matched_keywords.join(", "))}</small>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              `
              : ""
          }
        </div>
      `,
    )
    .join("");
}

function renderSections() {
  if (state.loading.workspace) {
    elements["section-list"].innerHTML = skeletonLines(4);
    elements["section-select"].innerHTML = '<option>Loading...</option>';
    return;
  }

  const sections = state.workspace?.sections ?? [];

  if (sections.length === 0) {
    elements["section-list"].innerHTML =
      emptyStatePanel({
        title: "No proposal map yet",
        detail: "Plan the proposal structure to reveal sections here.",
        actionLabel: "Plan structure",
        actionId: "plan-structure"
      });
    elements["section-select"].innerHTML = '<option>Executive Summary</option>';
    return;
  }

  elements["section-select"].innerHTML = sections
    .map(
      (section) => `
        <option value="${escapeHtml(section.name)}" ${
          section.name === state.selectedSection ? "selected" : ""
        }>${escapeHtml(section.name)}</option>
      `,
    )
    .join("");

  elements["section-list"].innerHTML = sections
    .map((section) => {
      const isOptimistic = state.optimistic.sectionName === section.name;
      const statusLabel = isOptimistic
        ? "Drafting"
        : section.exists
          ? "Drafted"
          : "Pending";

      return `
        <div class="section-item">
          <div class="section-top">
            <strong>${escapeHtml(section.name)}</strong>
            <span class="badge ${
              isOptimistic ? "pending" : section.exists ? "covered" : "pending"
            }">${statusLabel}</span>
          </div>
          <div class="section-actions">
            <button class="inline-button" data-select-section="${escapeHtml(section.name)}" type="button">Focus</button>
            <button class="inline-button" data-draft-section="${escapeHtml(section.name)}" type="button">Draft</button>
          </div>
        </div>
      `;
    })
    .join("");

  for (const button of elements["section-list"].querySelectorAll("[data-select-section]")) {
    button.addEventListener("click", () => {
      state.selectedSection = button.dataset.selectSection;
      render();
    });
  }

  for (const button of elements["section-list"].querySelectorAll("[data-draft-section]")) {
    button.addEventListener("click", async () => {
      state.selectedSection = button.dataset.draftSection;
      render();
      await runDraft();
    });
  }
}

function renderSectionPreview() {
  if (state.loading.workspace) {
    elements["section-preview"].textContent = "Loading section preview...";
    return;
  }

  if (state.optimistic.sectionName === state.selectedSection && state.optimistic.sectionContent) {
    elements["section-preview"].textContent = state.optimistic.sectionContent;
    elements["section-preview"].classList.add("skeleton");
    return;
  }

  elements["section-preview"].classList.remove("skeleton");

  const currentSection = state.workspace?.sections.find(
    (section) => section.name === state.selectedSection,
  );

  if (!currentSection) {
    elements["section-preview"].textContent =
      "Select or plan a section to preview it here.";
    return;
  }

  if (!currentSection.content) {
    elements["section-preview"].textContent =
      "Empty state: this section has not been drafted yet.";
    return;
  }

  elements["section-preview"].textContent = currentSection.content;
}

function renderProposalPreview() {
  if (state.loading.workspace) {
    elements["proposal-preview"].textContent = "Loading proposal preview...";
    return;
  }

  if (state.optimistic.proposalContent) {
    elements["proposal-preview"].textContent = state.optimistic.proposalContent;
    elements["proposal-preview"].classList.add("skeleton");
    return;
  }

  elements["proposal-preview"].classList.remove("skeleton");

  if (!state.workspace?.proposalContent) {
    elements["proposal-preview"].textContent =
      "Empty state: export the proposal to assemble the full markdown draft.";
    return;
  }

  elements["proposal-preview"].textContent = state.workspace.proposalContent;
}

function syncSectionSelection() {
  const availableSections = state.workspace?.sections.map((section) => section.name) ?? [];

  if (availableSections.length === 0) {
    state.selectedSection = "Executive Summary";
    return;
  }

  if (!availableSections.includes(state.selectedSection)) {
    state.selectedSection = availableSections[0];
  }
}

function resetOptimisticState() {
  state.optimistic = {
    sectionName: "",
    sectionContent: "",
    proposalContent: ""
  };
}

function showNotice(message, kind = "info") {
  elements["notice-bar"].dataset.message = message;
  elements["notice-bar"].dataset.kind = kind;
  renderNotice();
}

function clearNotice() {
  delete elements["notice-bar"].dataset.message;
  delete elements["notice-bar"].dataset.kind;
  renderNotice();
}

function toast(message, kind = "success") {
  const toastNode = document.createElement("div");
  toastNode.className = `toast ${kind === "error" ? "error" : ""}`;
  toastNode.textContent = message;
  toastNode.setAttribute("role", kind === "error" ? "alert" : "status");
  elements["toast-region"].appendChild(toastNode);

  window.setTimeout(() => {
    toastNode.remove();
  }, 3200);
}

async function submitWorkspaceCreate() {
  const label = elements["workspace-name-input"].value.trim();

  if (!label) {
    showNotice("Give the new workspace a short label first.", "error");
    return;
  }

  await createWorkspace(label, {
    button: elements["confirm-create-button"],
    busyLabel: "Creating..."
  });
}

function toggleFocusPopover(open) {
  elements["focus-popover"].classList.toggle("hidden", !open);
  elements["focus-popover-toggle"].setAttribute("aria-expanded", String(open));
  elements["focus-popover"].setAttribute("aria-hidden", String(!open));
}

function toggleWorkspaceCreatePanel(open) {
  elements["workspace-create-panel"].classList.toggle("hidden", !open);
  elements["workspace-create-panel"].setAttribute("aria-hidden", String(!open));
  elements["new-workspace-button"].setAttribute("aria-expanded", String(open));

  if (open) {
    elements["workspace-name-input"].value = "";
    window.setTimeout(() => {
      elements["workspace-name-input"].focus();
    }, 0);
  }
}

function openResetModal() {
  state.ui.modalReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  elements["modal-backdrop"].classList.remove("hidden");
  elements["modal-backdrop"].setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements["cancel-reset-button"].focus();
  }, 0);
}

function closeResetModal() {
  elements["modal-backdrop"].classList.add("hidden");
  elements["modal-backdrop"].setAttribute("aria-hidden", "true");

  if (state.ui.modalReturnFocus instanceof HTMLElement) {
    state.ui.modalReturnFocus.focus();
  }

  state.ui.modalReturnFocus = null;
}

function isResetModalOpen() {
  return !elements["modal-backdrop"].classList.contains("hidden");
}

function trapResetModalFocus(event) {
  const focusable = [
    elements["cancel-reset-button"],
    elements["confirm-reset-button"]
  ].filter((node) => node instanceof HTMLElement && !node.disabled);

  if (focusable.length === 0) {
    return;
  }

  const currentIndex = focusable.indexOf(document.activeElement);

  if (event.shiftKey && currentIndex <= 0) {
    event.preventDefault();
    focusable.at(-1)?.focus();
    return;
  }

  if (!event.shiftKey && currentIndex === focusable.length - 1) {
    event.preventDefault();
    focusable[0].focus();
  }
}

async function runEmptyAction(actionId, button) {
  if (!actionId) {
    return;
  }

  switch (actionId) {
    case "create-workspace":
      toggleWorkspaceCreatePanel(true);
      break;
    case "load-sample":
      setBusy(button, true, {
        busyLabel: "Loading..."
      });

      try {
        await loadSampleRfp(true);
      } finally {
        setBusy(button, false);
      }
      break;
    case "parse-rfp":
      await runParse();
      break;
    case "plan-structure":
      await sendOperatorMessage("/plan", {
        button,
        busyLabel: "Planning...",
        success: "Proposal structure replanned."
      });
      break;
    default:
      break;
  }
}

function logActivity(title, detail) {
  state.activity.unshift({
    title: sentenceCase(title),
    detail,
    at: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })
  });
}

function notifyOperatorBusy() {
  showNotice("Wait for the current operator action to finish before starting another.", "info");
  toast("Another operator action is still running.", "error");
}

function setDashboardInteractionLocked(locked, activeElement) {
  for (const id of dashboardLockIds) {
    const control = elements[id];

    if (!control || control === activeElement) {
      continue;
    }

    setTemporarilyDisabled(control, locked);
  }

  const dynamicControls =
    typeof document.querySelectorAll === "function"
      ? document.querySelectorAll("[data-workspace-id], [data-draft-section], [data-empty-action]")
      : [];

  for (const control of dynamicControls) {
    if (control === activeElement) {
      continue;
    }

    setTemporarilyDisabled(control, locked);
  }
}

function setTemporarilyDisabled(control, locked) {
  if (
    !control ||
    typeof control !== "object" ||
    !("disabled" in control) ||
    !("setAttribute" in control)
  ) {
    return;
  }

  if (locked) {
    control.dataset = control.dataset || {};
    control.dataset.temporarilyDisabled = "true";
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    return;
  }

  if (control.dataset?.temporarilyDisabled !== "true") {
    return;
  }

  control.disabled = false;
  control.setAttribute("aria-disabled", "false");
  delete control.dataset.temporarilyDisabled;
}

function setBusy(button, busy, options = {}) {
  if (!button) {
    return;
  }

  if (!button.dataset.idleLabel) {
    button.dataset.idleLabel = button.textContent.trim();
  }

  button.dataset.busy = busy ? "true" : "false";
  button.disabled = busy;
  button.setAttribute("aria-disabled", String(busy));
  button.setAttribute("aria-busy", String(busy));

  if (busy && options.busyLabel) {
    button.textContent = options.busyLabel;
    return;
  }

  if (!busy && button.dataset.idleLabel) {
    button.textContent = button.dataset.idleLabel;
  }
}

function skeletonLines(count) {
  return Array.from({ length: count })
    .map(
      () =>
        '<div class="activity-item skeleton" style="height: 4rem; border-radius: 16px;"></div>',
    )
    .join("");
}

function emptyStatePanel({ title, detail, actionLabel = "", actionId = "" }) {
  return `
    <div class="activity-item empty-state-panel">
      <span class="empty-state-mark">Idle</span>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(detail)}</small>
      ${
        actionLabel && actionId
          ? `<button class="inline-button" data-empty-action="${escapeHtml(actionId)}" type="button">${escapeHtml(actionLabel)}</button>`
          : ""
      }
    </div>
  `;
}

function parseDownloadFileName(dispositionHeader) {
  if (typeof dispositionHeader !== "string") {
    return "";
  }

  const match = dispositionHeader.match(/filename="([^"]+)"/i);
  return match ? match[1] : "";
}

async function fetchJson(url, options = {}) {
  let response;

  try {
    response = await window.fetch(url, {
      headers: {
        "content-type": "application/json"
      },
      ...options
    });
  } catch (error) {
    throw new RequestError("Network request failed.", {
      code: "NETWORK_ERROR",
      retryable: true,
      details: {
        cause: error instanceof Error ? error.message : String(error)
      }
    });
  }

  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    throw toRequestError(response.status, payload);
  }

  if (!isRecord(payload) || "__rawResponse" in payload) {
    throw new RequestError("Server returned a non-JSON response.", {
      status: response.status,
      code: "INVALID_RESPONSE",
      details:
        isRecord(payload) &&
        (typeof payload.__rawResponse === "string" || typeof payload.raw === "string")
          ? {
              response: extractErrorSnippet(
                typeof payload.__rawResponse === "string" ? payload.__rawResponse : payload.raw,
              )
            }
          : undefined
    });
  }

  return payload;
}

async function parseResponsePayload(response) {
  const raw = await response.text().catch(() => "");

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      __rawResponse: raw
    };
  }
}

function toRequestError(status, payload) {
  if (isRecord(payload)) {
    const details = isRecord(payload.details) ? { ...payload.details } : {};
    const rawResponse =
      typeof payload.__rawResponse === "string"
        ? extractErrorSnippet(payload.__rawResponse)
        : typeof payload.raw === "string"
          ? extractErrorSnippet(payload.raw)
          : undefined;

    if (rawResponse && typeof details.response !== "string") {
      details.response = rawResponse;
    }

    const message = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : `Request failed with ${status}`;
    const reasons = Array.isArray(payload.reasons)
      ? payload.reasons.filter((reason) => typeof reason === "string")
      : [];

    return new RequestError(message, {
      status,
      code: typeof payload.code === "string" ? payload.code : "REQUEST_ERROR",
      details: Object.keys(details).length > 0 ? details : undefined,
      retryable: payload.retryable === true,
      reasons
    });
  }

  return new RequestError(`Request failed with ${status}`, {
    status
  });
}

function reportUiError(
  error,
  {
    fallback = "Something went wrong.",
    showToast = true,
    toastMessage = undefined,
    notice = true,
    logTitle = "Error"
  } = {},
) {
  const normalized = normalizeError(error, fallback);

  if (notice) {
    showNotice(normalized.noticeMessage, "error");
  }

  if (showToast) {
    toastMessage ? toast(toastMessage, "error") : toast(normalized.toastMessage, "error");
  }

  logActivity(logTitle, normalized.logMessage);
  return normalized;
}

function normalizeError(error, fallback) {
  if (error instanceof RequestError) {
    const reasonText = error.reasons.length > 0 ? ` ${error.reasons.join(" ")}` : "";
    const retryHint = error.retryable ? " You can try again." : "";
    const noticeMessage = `${error.message}${reasonText}${retryHint}`.trim();
    const code = error.code && error.code !== "REQUEST_ERROR" ? ` [${error.code}]` : "";
    const detailText = summarizeRequestDetails(error.details);

    return {
      noticeMessage,
      toastMessage: noticeMessage,
      logMessage: `${error.message}${code}${detailText}`
    };
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      noticeMessage: error.message.trim(),
      toastMessage: error.message.trim(),
      logMessage: error.message.trim()
    };
  }

  return {
    noticeMessage: fallback,
    toastMessage: fallback,
    logMessage: fallback
  };
}

function summarizeRequestDetails(details) {
  if (!isRecord(details)) {
    return "";
  }

  const parts = [];

  if (typeof details.service === "string" && details.service.trim()) {
    parts.push(`service=${details.service.trim()}`);
  }

  if (typeof details.method === "string" && details.method.trim()) {
    parts.push(`method=${details.method.trim()}`);
  }

  if (Array.isArray(details.allowedMethods)) {
    const allowedMethods = details.allowedMethods.filter(
      (value) => typeof value === "string" && value.trim(),
    );

    if (allowedMethods.length > 0) {
      parts.push(`allowed=${allowedMethods.join(",")}`);
    }
  }

  if (typeof details.path === "string" && details.path.trim()) {
    parts.push(`path=${details.path.trim()}`);
  }

  if (typeof details.filePath === "string" && details.filePath.trim()) {
    parts.push(`file=${details.filePath.trim()}`);
  }

  if (typeof details.target === "string" && details.target.trim()) {
    parts.push(`target=${details.target.trim()}`);
  }

  if (typeof details.response === "string" && details.response.trim()) {
    parts.push(`response=${extractErrorSnippet(details.response)}`);
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function extractErrorSnippet(value, limit = 160) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatGuardrailNotice(guardrail) {
  const reasons = Array.isArray(guardrail?.reasons)
    ? guardrail.reasons.filter((reason) => typeof reason === "string" && reason.trim())
    : [];

  if (reasons.length === 0) {
    return "Guardrails adjusted risky wording before saving.";
  }

  return `Guardrails adjusted risky wording before saving. ${reasons.join(" ")}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sentenceCase(value) {
  if (!value) {
    return "";
  }

  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
