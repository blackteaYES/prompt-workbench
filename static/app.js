const state = {
  sessions: [],
  session: null,
  selectedVersionId: null,
  selectedAnswerOptions: [],
  answerDraftQuestionId: null,
  answerDraftContent: "",
  feedbackDraftContent: "",
  feedbackCollapsed: false,
  scoreCollapsed: false,
  historyCollapsed: false,
  activeQuestionId: null,
  composerMode: null,
  promptView: "preview",
  workspaceView: "interview",
  previewFilter: "all",
  previewExpanded: new Set(["context"]),
  selectedEvaluationId: null,
  pickerWorkflow: null,
  generationPending: false,
  evaluationPending: false,
  feedbackPending: false,
  canGenerate: false,
  modelSettings: null,
  retryMode: null,
  pendingAnswerCheck: null,
  recommendationPendingQuestionId: null,
  recommendationFailedQuestionId: null,
  modelLists: { openai: [], ollama: [] },
  askNextPending: false,
  conversationThinkingTimer: null,
  conversationThinkingStartedAt: 0,
  suppressAutoRetry: false,
  renderedSessionId: null,
  toastTimer: null
};

const byId = (id) => document.getElementById(id);
const QUESTION_JUMP_TICK_LIMIT = 12;

function revealElement(element, delay = 0) {
  if (!element || typeof element.animate !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.animate([
    { opacity: 0, transform: "translateY(8px)" },
    { opacity: 1, transform: "translateY(0)" },
  ], { duration: 340, delay, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" });
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  try {
    return await window.browserApiRequest(path, options);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.message || "浏览器操作未完成，请重试。", Number.isFinite(error.status) ? error.status : 502);
  }
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (button.id === "generate-button") {
    const labelNode = byId("generate-button-label");
    if (busy) { button.dataset.originalLabel = labelNode.textContent; labelNode.textContent = label || "正在处理…"; }
    else if (button.dataset.originalLabel) { labelNode.textContent = button.dataset.originalLabel; delete button.dataset.originalLabel; }
    button.disabled = busy;
    return;
  }
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.textContent = label || "正在处理…";
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalHtml || button.innerHTML;
    delete button.dataset.originalHtml;
    button.disabled = false;
  }
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3300);
}

function hideRetry() {
  state.retryMode = null;
  byId("retry-row").classList.add("is-hidden");
}

function showRetry(message, mode) {
  state.retryMode = mode;
  byId("retry-copy").textContent = message;
  const needsModelSettings = /(?:尚未配置|未配置|缺少).*(?:API\s*Key|密钥|模型)/i.test(message);
  const shouldOfferModelSettings = needsModelSettings || /(?:API\s*Key|密钥|Base URL|模型名称|模型服务找不到)/i.test(message);
  byId("open-model-settings-retry").classList.toggle("is-hidden", !shouldOfferModelSettings);
  const labels = {
    generate: "重试生成 ↗",
    "answer-check": "检查回答状态 ↗",
    answer: "重试访谈 ↗",
    initial: "重试访谈 ↗",
    refinement: "重试访谈 ↗"
  };
  byId("retry-button").textContent = labels[mode] || "重试访谈 ↗";
  byId("session-state-label").textContent = "需要重试";
  byId("retry-row").classList.remove("is-hidden");
  if (needsModelSettings) openModelSettingsDialog({ focusApiKey: true });
}

function setSidebarCollapsed(collapsed, persist = true) {
  document.querySelector(".app-shell").classList.toggle("is-sidebar-collapsed", collapsed);
  const button = byId("sidebar-toggle");
  button.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = collapsed ? "展开侧栏" : "收起侧栏";
  if (persist) {
    try {
      localStorage.setItem("prompt-room-sidebar-collapsed", String(collapsed));
    } catch {
      // 浏览器禁用本地存储时仍保留当前页面的收起状态。
    }
  }
}

function setWorkspaceVisible(isVisible) {
  byId("welcome-view").classList.toggle("is-hidden", isVisible);
  byId("workspace-view").classList.toggle("is-hidden", !isVisible);
  byId("crumb-current").textContent = isVisible && state.session ? state.session.title : "新建工作区";
}

function displayDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function displayDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function refreshSessions() {
  const payload = await request("/api/sessions");
  state.sessions = payload.sessions || [];
  byId("session-count").textContent = String(state.sessions.length).padStart(2, "0");
  renderSessionList();
}

function renderSessionList() {
  const list = byId("session-list");
  list.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "这里还没有保存的工作区。";
    list.append(empty);
    return;
  }

  for (const item of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = `session-item${state.session?.id === item.id ? " is-active" : ""}`;
    open.setAttribute("aria-current", state.session?.id === item.id ? "page" : "false");
    const title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "session-item-meta";
    meta.textContent = `${displayDate(item.updated_at)} · ${item.version_count} 个版本`;
    open.append(title, meta);
    if (item.latest_score !== null && item.latest_score !== undefined) {
      const score = document.createElement("span");
      score.className = "session-item-score";
      score.textContent = `${item.latest_score} 分`;
      open.append(score);
    }
    open.addEventListener("click", () => openSession(item.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "session-delete";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除会话：${item.title}`);
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!window.confirm(`确定逐个删除“${item.title}”吗？此操作会删除该会话的问答和版本。`)) return;
      try {
        await request(`/api/sessions/${item.id}`, { method: "DELETE" });
        if (state.session?.id === item.id) {
          state.session = null;
          state.selectedVersionId = null;
          state.pendingAnswerCheck = null;
          state.feedbackCollapsed = false;
          setWorkspaceVisible(false);
        }
        await refreshSessions();
        showToast("这个工作区已删除。");
      } catch (error) {
        showToast(error.message);
      }
    });
    row.append(open, remove);
    list.append(row);
  }
}

async function loadSession(sessionId) {
  if (state.session?.id !== sessionId) {
    state.workspaceView = "interview";
    state.previewFilter = "all";
    state.previewExpanded.clear();
    state.previewExpanded.add("context");
    state.selectedEvaluationId = null;
    state.selectedAnswerOptions = [];
    state.answerDraftQuestionId = null;
    state.answerDraftContent = "";
    state.feedbackDraftContent = "";
    state.feedbackCollapsed = false;
    state.activeQuestionId = null;
    state.composerMode = null;
    state.pendingAnswerCheck = null;
  }
  state.session = await request(`/api/sessions/${sessionId}`);
  const currentQuestion = state.session.messages[state.session.messages.length - 1];
  const needsRecommendation = currentQuestion?.role === "assistant" &&
    currentQuestion.kind === "question" &&
    Array.isArray(currentQuestion.suggested_answers) &&
    currentQuestion.suggested_answers.length > 0 &&
    !currentQuestion.recommended_answer;
  state.recommendationPendingQuestionId = needsRecommendation ? currentQuestion.id : null;
  state.recommendationFailedQuestionId = null;
  const newest = state.session.versions[0];
  if (!state.selectedVersionId || !state.session.versions.some((version) => version.id === state.selectedVersionId)) {
    state.selectedVersionId = newest ? newest.id : null;
  }
  renderWorkspace();
  setWorkspaceVisible(true);
  renderSessionList();
  if (needsRecommendation) requestRecommendation(sessionId, currentQuestion.id);
}

async function requestRecommendation(sessionId, questionId) {
  try {
    const result = await request(`/api/sessions/${sessionId}/recommendation`, { method: "POST" });
    if (state.session?.id !== sessionId || String(state.recommendationPendingQuestionId) !== String(questionId)) return;
    const question = state.session.messages.find((message) => String(message.id) === String(questionId));
    if (!question || question.kind !== "question") return;
    state.recommendationPendingQuestionId = null;
    if (result.recommended_answer && question.suggested_answers.includes(result.recommended_answer)) {
      question.recommended_answer = result.recommended_answer;
      state.recommendationFailedQuestionId = null;
    } else {
      state.recommendationFailedQuestionId = questionId;
    }
    const activeForm = byId("answer-form");
    if (activeForm?.dataset.questionId === String(questionId)) applyOptionRecommendation(activeForm, question);
    else renderWorkspace();
  } catch {
    if (state.session?.id !== sessionId || String(state.recommendationPendingQuestionId) !== String(questionId)) return;
    state.recommendationPendingQuestionId = null;
    state.recommendationFailedQuestionId = questionId;
    const activeForm = byId("answer-form");
    if (activeForm?.dataset.questionId === String(questionId)) applyOptionRecommendation(activeForm, {});
    else renderWorkspace();
  }
}

async function openSession(sessionId) {
  hideRetry();
  state.selectedVersionId = null;
  try {
    await loadSession(sessionId);
    byId("sidebar").classList.remove("is-open");
  } catch (error) {
    showToast(error.message);
  }
}

function quickAnswersFor(message) {
  let answers = [];
  if (Array.isArray(message.suggested_answers) && message.suggested_answers.length) {
    answers = message.suggested_answers.filter((item) => typeof item === "string" && item.trim()).slice(0, 5);
  } else {
    const examples = message.content.match(/(?:例如|比如)[：:]\s*([\s\S]*?)(?:[？?]|$)/);
    if (examples) {
      const choices = examples[1]
        .split(/[、，,；;]|\s*还是\s*|\s*或者\s*/)
        .map((item) => item.replace(/^[“"「]|[”"”。]$/g, "").trim())
        .filter((item) => item.length > 2 && item.length < 65);
      if (choices.length >= 2) answers = choices.slice(0, 5);
    }
  }

  if (!answers.length) {
    const isChinese = /[\u3400-\u9fff]/.test(message.content);
    answers = isChinese
      ? ["请先给我几个方向参考", "按常见场景帮我推荐", "我还没想好，继续引导我"]
      : ["Show me a few options", "Recommend a common approach", "I'm not sure yet; guide me"];
  }
  const recommended = message.recommended_answer;
  return recommended && answers.includes(recommended)
    ? [recommended, ...answers.filter((answer) => answer !== recommended)]
    : answers;
}

function createQuestionOptionsPreview(message) {
  const answers = quickAnswersFor(message);
  if (!answers.length) return null;
  const relatedAnswer = state.session?.messages.find((item) =>
    item.role === "user" && item.kind === "answer" && String(item.question_id) === String(message.id)
  );
  const selected = new Set(relatedAnswer ? parseAnswerContent(relatedAnswer.content).selectedOptions : []);
  const details = document.createElement("details");
  details.className = "question-options-preview";
  const summary = document.createElement("summary");
  summary.textContent = `查看当时的选项 · ${answers.length}`;
  const list = document.createElement("div");
  list.className = "question-options-preview-list";
  for (const answer of answers) {
    const option = document.createElement("span");
    option.className = `question-options-preview-item${answer === message.recommended_answer ? " is-recommended" : ""}${selected.has(answer) ? " is-selected" : ""}`;
    option.textContent = answer;
    if (answer === message.recommended_answer) {
      const tag = document.createElement("small");
      tag.textContent = "推荐";
      option.append(tag);
    }
    if (selected.has(answer)) {
      const tag = document.createElement("small");
      tag.className = "selected-tag";
      tag.textContent = "已选";
      option.append(tag);
    }
    list.append(option);
  }
  details.append(summary, list);
  return details;
}

function createAnswerEditForm(message, question) {
  const answer = parseAnswerContent(message.content);
  const selected = new Set(answer.selectedOptions);
  const choices = [...new Set([...quickAnswersFor(question), ...answer.selectedOptions])];
  const form = document.createElement("form");
  form.className = "answer-edit-form is-hidden";

  const label = document.createElement("span");
  label.className = "answer-edit-label";
  label.textContent = "修改这条回答（可多选）";
  const list = document.createElement("div");
  list.className = "answer-edit-options";
  const count = document.createElement("span");
  count.className = "answer-edit-count";
  const updateCount = () => {
    count.textContent = selected.size ? `已选 ${selected.size} 项` : "可选择多项";
  };
  for (const choice of choices) {
    const button = document.createElement("button");
    const isSelected = selected.has(choice);
    button.type = "button";
    button.className = `quick-reply-button${isSelected ? " is-selected" : ""}${question.recommended_answer === choice ? " is-recommended" : ""}`;
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = choice;
    button.addEventListener("click", () => {
      if (selected.has(choice)) selected.delete(choice);
      else selected.add(choice);
      button.classList.toggle("is-selected", selected.has(choice));
      button.setAttribute("aria-pressed", String(selected.has(choice)));
      updateCount();
    });
    list.append(button);
  }
  updateCount();

  const customLabel = document.createElement("label");
  customLabel.className = "answer-edit-custom-label";
  customLabel.textContent = "补充说明";
  const customInput = document.createElement("textarea");
  customInput.className = "answer-edit-custom";
  customInput.maxLength = 12000;
  customInput.rows = 2;
  customInput.value = answer.content;
  customInput.placeholder = "补充背景、例子，或说明所选方向…";
  customLabel.append(customInput);

  const footer = document.createElement("div");
  footer.className = "answer-edit-footer";
  footer.append(count);
  const actions = document.createElement("div");
  actions.className = "answer-edit-actions";
  const cancel = document.createElement("button");
  cancel.className = "answer-edit-cancel";
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    form.classList.add("is-hidden");
    form.parentElement.querySelector(".message-edit-button").textContent = "修改回答";
    form.parentElement.querySelector(".message-edit-button").setAttribute("aria-expanded", "false");
  });
  const save = document.createElement("button");
  save.className = "answer-edit-save";
  save.type = "submit";
  save.textContent = "保存修改";
  actions.append(cancel, save);
  footer.append(actions);
  form.append(label, list, customLabel, footer);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const customContent = customInput.value.trim();
    const selectedOptions = [...selected];
    if (!customContent && !selectedOptions.length) {
      showToast("请至少选择一项，或填写补充说明。");
      return;
    }
    const scroll = byId("conversation-scroll");
    const scrollTop = scroll.scrollTop;
    setBusy(save, true, "正在保存…");
    try {
      const updatedSession = await request(`/api/sessions/${state.session.id}/messages/${message.id}`, {
        method: "PUT",
        body: JSON.stringify({ content: customContent, selected_options: selectedOptions })
      });
      state.session = updatedSession;
      renderWorkspace();
      window.requestAnimationFrame(() => {
        scroll.scrollTop = scrollTop;
        updateQuestionJumpActive();
      });
      await refreshSessions().catch(() => {});
      showToast("回答已修改；后续问答已保留，生成新版时会采用这次修改。");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(save, false);
    }
  });
  return form;
}

function applyOptionRecommendation(form, message) {
  const list = form.querySelector(".quick-replies-list");
  const hint = form.querySelector(".quick-replies-footer span:first-child");
  for (const button of list?.querySelectorAll(".quick-reply-button") || []) {
    const isRecommended = button.dataset.answer === message.recommended_answer;
    button.classList.toggle("is-recommended", isRecommended);
    if (isRecommended) {
      button.setAttribute("aria-label", `${button.dataset.answer}，模型推荐`);
      button.title = "模型根据当前需求推荐，可自行更改或与其他选项一起选择。";
      list.prepend(button);
    } else {
      button.removeAttribute("aria-label");
      button.removeAttribute("title");
    }
  }
  if (hint) {
    hint.textContent = message.recommended_answer
      ? "“模型推荐”是参考项；仍可改选、多选或补充文字。"
      : "暂时没有生成推荐项；仍可自行多选或补充回答。";
  }
}

function createAnswerComposer(message, hasVersions) {
  const form = document.createElement("form");
  form.className = "answer-composer";
  form.id = "answer-form";
  form.dataset.questionId = String(message.id || "");
  const fields = document.createElement("div");
  fields.className = "answer-fields";
  form.append(fields);
  const updateSubmit = () => {
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = state.generationPending || state.evaluationPending || form.getAttribute("aria-busy") === "true" || (!state.selectedAnswerOptions.length && !state.answerDraftContent.trim());
  };

  if (message.kind === "question") {
    const optionsBlock = document.createElement("div");
    optionsBlock.className = "quick-replies";
    const label = document.createElement("div");
    label.className = "quick-replies-label";
    label.textContent = "选择回答方向（可多选）";
    const list = document.createElement("div");
    list.className = "quick-replies-list";
    for (const answer of quickAnswersFor(message)) {
      const button = document.createElement("button");
      const isSelected = state.selectedAnswerOptions.includes(answer);
      const isRecommended = message.recommended_answer === answer;
      button.type = "button";
      button.className = `quick-reply-button${isSelected ? " is-selected" : ""}${isRecommended ? " is-recommended" : ""}`;
      button.setAttribute("aria-pressed", String(isSelected));
      if (isRecommended) {
        button.setAttribute("aria-label", `${answer}，模型推荐`);
        button.title = "模型根据当前需求推荐，可自行更改或与其他选项一起选择。";
      }
      button.textContent = answer;
      button.addEventListener("click", () => {
        const currentIndex = state.selectedAnswerOptions.indexOf(answer);
        if (currentIndex === -1) state.selectedAnswerOptions.push(answer);
        else state.selectedAnswerOptions.splice(currentIndex, 1);
        for (const optionButton of list.querySelectorAll(".quick-reply-button")) {
          const selected = state.selectedAnswerOptions.includes(optionButton.dataset.answer);
          optionButton.classList.toggle("is-selected", selected);
          optionButton.setAttribute("aria-pressed", String(selected));
        }
        selectedCount.textContent = state.selectedAnswerOptions.length
          ? `已选 ${state.selectedAnswerOptions.length} 项`
          : "可选择多项";
        updateSubmit();
      });
      button.dataset.answer = answer;
      list.append(button);
    }
    const optionsFooter = document.createElement("div");
    optionsFooter.className = "quick-replies-footer";
    const hint = document.createElement("span");
    hint.textContent = message.recommended_answer
      ? "“模型推荐”是参考项；仍可改选、多选或补充文字。"
      : String(state.recommendationPendingQuestionId) === String(message.id)
        ? "模型正在结合已有需求选择推荐项；你也可以先选答案。"
        : String(state.recommendationFailedQuestionId) === String(message.id)
          ? "暂时没有生成推荐项；仍可自行多选或补充回答。"
          : "点选多个选项；选项和文字会一起显示在对话中。";
    const selectedCount = document.createElement("span");
    selectedCount.id = "selected-answer-count";
    selectedCount.textContent = state.selectedAnswerOptions.length
      ? `已选 ${state.selectedAnswerOptions.length} 项`
      : "可选择多项";
    optionsFooter.append(hint, selectedCount);
    optionsBlock.append(label, list, optionsFooter);
    fields.append(optionsBlock);
  }

  const label = document.createElement("label");
  label.className = "composer-label answer-custom-label";
  label.htmlFor = "answer-input";
  label.textContent = message.kind === "question" ? "补充说明（选填）" : "补充你的想法";
  const input = document.createElement("textarea");
  input.id = "answer-input";
  input.maxLength = 12000;
  input.rows = 2;
  input.placeholder = message.kind === "question" ? "可补充背景、例子，或说明所选方向…" : "写下你还想补充的内容…";
  input.value = state.answerDraftContent;
  input.addEventListener("input", () => { state.answerDraftContent = input.value; updateSubmit(); });
  fields.append(label, input);

  const footer = document.createElement("div");
  footer.className = "composer-bottom answer-composer-footer";
  const footerHint = document.createElement("span");
  footerHint.className = "muted-hint";
  footerHint.textContent = "至少选择一项或填写补充说明。";
  const submit = document.createElement("button");
  submit.className = "secondary-button";
  submit.type = "submit";
  submit.innerHTML = "提交回答并继续 <span aria-hidden=\"true\">↗</span>";
  footer.append(footerHint, submit);
  form.append(footer);

  if (hasVersions && message.kind === "question") {
    const switchMode = document.createElement("button");
    switchMode.className = "composer-mode-link";
    switchMode.type = "button";
    switchMode.textContent = "先不回答，改为提交版本意见";
    switchMode.addEventListener("click", () => {
      state.composerMode = "feedback";
      renderWorkspace();
      byId("feedback-input").focus();
    });
    form.append(switchMode);
  }
  form.addEventListener("submit", submitAnswer);
  updateSubmit();
  return form;
}

function createFeedbackComposer(hasActiveQuestion) {
  const form = document.createElement("form");
  form.className = "feedback-card";
  form.id = "feedback-form";

  const heading = document.createElement("div");
  heading.className = "feedback-head";
  const title = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "版本反馈";
  const headingText = document.createElement("h2");
  headingText.textContent = "告诉我这版还想改哪里";
  title.append(eyebrow, headingText);
  const badge = document.createElement("span");
  badge.className = "feedback-count";
  const latestVersion = state.session.versions[0];
  badge.textContent = `基于版本 ${String(latestVersion.revision).padStart(2, "0")}`;
  const headingActions = document.createElement("div");
  headingActions.className = "feedback-head-actions";
  const collapseButton = document.createElement("button");
  collapseButton.className = "feedback-collapse-button";
  collapseButton.type = "button";
  collapseButton.textContent = "收起";
  collapseButton.setAttribute("aria-label", "收起版本反馈");
  collapseButton.addEventListener("click", () => {
    state.feedbackDraftContent = input.value;
    state.feedbackCollapsed = true;
    renderWorkspace();
  });
  headingActions.append(badge, collapseButton);
  heading.append(title, headingActions);
  form.append(heading);

  if (hasActiveQuestion) {
    const pauseNote = document.createElement("div");
    pauseNote.className = "feedback-pause-note";
    pauseNote.textContent = "当前问题会暂时放一边；提交意见后可以回来继续回答。";
    const returnButton = document.createElement("button");
    returnButton.type = "button";
    returnButton.className = "composer-mode-link";
    returnButton.textContent = "返回当前问题并回答";
    returnButton.addEventListener("click", () => {
      state.composerMode = null;
      renderWorkspace();
    });
    const pauseRow = document.createElement("div");
    pauseRow.className = "feedback-pause-row";
    pauseRow.append(pauseNote, returnButton);
    form.append(pauseRow);
  }

  const label = document.createElement("label");
  label.className = "composer-label";
  label.htmlFor = "feedback-input";
  label.textContent = "修改意见";
  const input = document.createElement("textarea");
  input.id = "feedback-input";
  input.maxLength = 12000;
  input.rows = 3;
  input.placeholder = "例如：语气再轻松一点，并加入适合雨天的备选方案。";
  input.value = state.feedbackDraftContent;
  input.addEventListener("input", () => { state.feedbackDraftContent = input.value; });
  form.append(label, input);

  const footer = document.createElement("div");
  footer.className = "composer-bottom";
  const hint = document.createElement("span");
  hint.className = "muted-hint";
  hint.textContent = "提交后会继续访谈；生成下一版仍由你手动触发。";
  const submit = document.createElement("button");
  submit.className = "secondary-button";
  submit.type = "submit";
  submit.innerHTML = "提交修改意见 <span aria-hidden=\"true\">↗</span>";
  footer.append(hint, submit);
  form.append(footer);
  form.addEventListener("submit", submitFeedback);
  return form;
}

function createCollapsedFeedback(hasActiveQuestion) {
  const row = document.createElement("div");
  row.className = "feedback-collapsed-row";
  const copy = document.createElement("span");
  copy.textContent = state.feedbackDraftContent.trim()
    ? "版本反馈已收起，修改意见草稿已保留。"
    : "版本反馈已收起。";
  const actions = document.createElement("div");
  actions.className = "feedback-collapsed-actions";
  const expandButton = document.createElement("button");
  expandButton.className = "feedback-expand-button";
  expandButton.type = "button";
  expandButton.textContent = "展开版本反馈";
  expandButton.addEventListener("click", () => {
    state.feedbackCollapsed = false;
    renderWorkspace();
    byId("feedback-input")?.focus();
  });
  actions.append(expandButton);
  if (hasActiveQuestion) {
    const returnButton = document.createElement("button");
    returnButton.className = "feedback-return-button";
    returnButton.type = "button";
    returnButton.textContent = "返回当前问题";
    returnButton.addEventListener("click", () => {
      state.feedbackCollapsed = false;
      state.composerMode = null;
      renderWorkspace();
    });
    actions.append(returnButton);
  }
  row.append(copy, actions);
  return row;
}

function parseAnswerContent(content) {
  const match = String(content || "").match(/^选择的选项：\n([\s\S]*?)(?:\n\n补充说明：\n([\s\S]*))?$/);
  if (!match) return { selectedOptions: [], content: String(content || "") };
  return {
    selectedOptions: match[1].split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean),
    content: match[2]?.trim() || "",
  };
}

function renderAnswerRecord(target, message) {
  const answer = parseAnswerContent(message.content);
  if (!answer.selectedOptions.length) {
    target.textContent = answer.content;
    return;
  }
  const record = document.createElement("div");
  record.className = "answer-record";
  const label = document.createElement("span");
  label.className = "answer-record-label";
  label.textContent = answer.selectedOptions.length > 1 ? `选择了 ${answer.selectedOptions.length} 项` : "选择的方向";
  const chips = document.createElement("div");
  chips.className = "answer-record-options";
  for (const choice of answer.selectedOptions) {
    const chip = document.createElement("span");
    chip.className = "answer-record-option";
    chip.textContent = choice;
    chips.append(chip);
  }
  record.append(label, chips);
  if (answer.content) {
    const detail = document.createElement("p");
    detail.className = "answer-record-detail";
    detail.textContent = answer.content;
    record.append(detail);
  }
  target.append(record);
}

function makeMessage(message, options = {}) {
  const wrapper = document.createElement("article");
  const speaker = message.role === "user" ? "user" : "assistant";
  wrapper.className = `message ${speaker}${message.kind === "question" ? " is-question" : ""}${message.kind === "notice" ? " is-notice" : ""}`;
  wrapper.dataset.messageId = String(message.id);
  if (options.isNew) wrapper.classList.add("is-new");
  if (speaker === "assistant" && message.kind === "question") wrapper.dataset.questionId = String(message.id);
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = speaker === "user" ? "你" : "问";
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("strong");
  name.textContent = speaker === "user" ? (message.kind === "feedback" ? "你的修改意见" : "你") : (message.kind === "notice" ? "梳理提示" : "需求访谈员");
  const isUserAnswer = speaker === "user" && message.kind === "answer";
  if (!isUserAnswer && speaker !== "user") meta.append(name);
  else if (message.kind === "feedback") meta.append(name);
  if (Number.isInteger(options.questionNumber)) {
    const round = document.createElement("span");
    round.className = "message-round-number";
    round.textContent = `${speaker === "user" ? "答" : "问"} ${String(options.questionNumber).padStart(2, "0")}`;
    round.setAttribute("aria-label", speaker === "user"
      ? `第 ${options.questionNumber} 个问题的回答`
      : `第 ${options.questionNumber} 个问题`);
    round.title = speaker === "user" ? `对应第 ${options.questionNumber} 个问题` : `第 ${options.questionNumber} 个问题`;
    meta.append(round);
  }
  const timestamp = document.createElement("span");
  timestamp.textContent = displayDateTime(message.created_at);
  meta.append(timestamp);
  const text = document.createElement("div");
  text.className = "message-text";
  if (speaker === "user" && message.kind === "answer") renderAnswerRecord(text, message);
  else text.textContent = message.content;
  body.append(meta, text);
  if (speaker === "user" && message.kind === "answer" && message.edited_at) {
    const edited = document.createElement("span");
    edited.className = "answer-edited-mark";
    edited.textContent = "已修改";
    meta.append(edited);
  }
  if (speaker === "assistant" && message.kind === "question" && (!options.isActiveQuestion || options.isFeedbackMode)) {
    const preview = createQuestionOptionsPreview(message);
    if (preview) body.append(preview);
  }
  if (speaker === "user" && message.kind === "answer" && message.question_id) {
    const question = state.session?.messages.find((item) => String(item.id) === String(message.question_id));
    if (question) {
      const editor = createAnswerEditForm(message, question);
      const actions = document.createElement("div");
      actions.className = "message-inline-actions";
      const editButton = document.createElement("button");
      editButton.className = "message-edit-button";
      editButton.type = "button";
      editButton.textContent = "修改回答";
      editButton.setAttribute("aria-expanded", "false");
      editButton.addEventListener("click", () => {
        const isOpen = !editor.classList.contains("is-hidden");
        editor.classList.toggle("is-hidden", isOpen);
        if (!isOpen) revealElement(editor);
        editButton.textContent = isOpen ? "修改回答" : "收起修改";
        editButton.setAttribute("aria-expanded", String(!isOpen));
      });
      actions.append(editButton);
      body.append(actions, editor);
    }
  }
  if (options.isActiveQuestion && options.isFeedbackMode) {
    const paused = document.createElement("div");
    paused.className = "question-paused-note";
    paused.textContent = "当前先处理版本意见；提交后可回来回答这道问题。";
    body.append(paused);
  }
  wrapper.append(avatar, body);
  return wrapper;
}

function renderQuestionJump(messages) {
  const questions = messages.filter((message) => message.role === "assistant" && message.kind === "question");
  const nav = byId("question-jump-nav");
  const ruler = byId("question-jump-ruler");
  const list = byId("question-jump-menu-list");
  nav.classList.toggle("is-hidden", questions.length === 0);
  byId("question-jump-count").textContent = `${questions.length} 个问题`;
  ruler.replaceChildren();
  list.replaceChildren();
  if (!questions.some((question) => String(question.id) === String(state.activeQuestionId))) {
    state.activeQuestionId = questions.length ? String(questions[questions.length - 1].id) : null;
  }

  const tickCount = Math.min(QUESTION_JUMP_TICK_LIMIT, questions.length);
  const tickQuestionIndexes = Array.from({ length: tickCount }, (_, index) => tickCount === 1
    ? 0
    : Math.round(index * (questions.length - 1) / (tickCount - 1)));
  tickQuestionIndexes.forEach((questionIndex) => {
    const question = questions[questionIndex];
    const tick = document.createElement("span");
    tick.className = "question-jump-tick";
    tick.dataset.questionId = String(question.id);
    tick.setAttribute("aria-hidden", "true");
    ruler.append(tick);
  });

  questions.forEach((question, index) => {
    const item = document.createElement("button");
    item.className = "question-jump-item";
    item.type = "button";
    item.dataset.questionId = String(question.id);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.setAttribute("aria-label", `第 ${index + 1} 问：${question.content}`);
    item.title = question.content;
    const number = document.createElement("span");
    number.className = "question-jump-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "question-jump-text";
    text.textContent = question.content;
    item.append(number, text);
    list.append(item);
  });
  setActiveQuestionJump(state.activeQuestionId);
}

function setActiveQuestionJump(questionId) {
  state.activeQuestionId = questionId ? String(questionId) : null;
  const items = [...byId("question-jump-menu-list").querySelectorAll(".question-jump-item")];
  const activeIndex = items.findIndex((item) => item.dataset.questionId === state.activeQuestionId);
  for (const item of items) {
    const active = item.dataset.questionId === state.activeQuestionId;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  }
  const ticks = [...byId("question-jump-ruler").querySelectorAll(".question-jump-tick")];
  const activeTickIndex = activeIndex < 0 || items.length < 2
    ? activeIndex
    : Math.round(activeIndex * (ticks.length - 1) / (items.length - 1));
  ticks.forEach((tick, index) => {
    tick.classList.toggle("is-active", index === activeTickIndex);
  });
}

function updateQuestionJumpActive() {
  const scroll = byId("conversation-scroll");
  if (!scroll) return;
  const questions = [...byId("message-list").querySelectorAll(".message.is-question[data-question-id]")];
  if (!questions.length) return;
  const threshold = scroll.getBoundingClientRect().top + Math.min(110, scroll.clientHeight * 0.34);
  let active = questions[0];
  for (const question of questions) {
    if (question.getBoundingClientRect().top <= threshold) active = question;
    else break;
  }
  setActiveQuestionJump(active.dataset.questionId);
}

function jumpToQuestion(questionId) {
  const target = [...byId("message-list").querySelectorAll(".message.is-question[data-question-id]")]
    .find((message) => message.dataset.questionId === String(questionId));
  if (!target) return;
  const scroll = byId("conversation-scroll");
  const targetTop = scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
  scroll.scrollTo({ top: targetTop, behavior: "smooth" });
  setActiveQuestionJump(questionId);
}

function getSelectedVersion() {
  if (!state.session?.versions?.length) return null;
  return state.session.versions.find((version) => version.id === state.selectedVersionId) || state.session.versions[0];
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    const content = token.startsWith("**") || token.startsWith("__")
      ? token.slice(2, -2)
      : token.slice(1, -1);
    const node = document.createElement(token.startsWith("`") ? "code" : token.startsWith("**") || token.startsWith("__") ? "strong" : "em");
    node.textContent = content;
    parent.append(node);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(source, target) {
  target.replaceChildren();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  let listType = null;
  let quote = [];
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const block = document.createElement("p");
    appendInlineMarkdown(block, paragraph.join(" "));
    target.append(block);
    paragraph = [];
  };
  const flushList = () => {
    if (list) target.append(list);
    list = null;
    listType = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const block = document.createElement("blockquote");
    const content = document.createElement("p");
    appendInlineMarkdown(content, quote.join(" "));
    block.append(content);
    target.append(block);
    quote = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      flushQuote();
      if (inCode) {
        const pre = document.createElement("pre");
        const block = document.createElement("code");
        block.textContent = code.join("\n");
        pre.append(block);
        target.append(pre);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quoteLine = line.match(/^\s*>\s?(.*)$/);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
    } else if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Number(heading[1].length);
      const block = document.createElement(level <= 2 ? "h3" : "h4");
      appendInlineMarkdown(block, heading[2]);
      target.append(block);
    } else if (/^\s*(?:---|\*\*\*)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      target.append(document.createElement("hr"));
    } else if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const nextType = bullet ? "ul" : "ol";
      if (listType !== nextType) {
        flushList();
        list = document.createElement(nextType);
        listType = nextType;
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, (bullet || numbered)[1]);
      list.append(item);
    } else if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1]);
    } else {
      flushList();
      flushQuote();
      paragraph.push(line.trim());
    }
  }

  if (inCode) {
    const pre = document.createElement("pre");
    const block = document.createElement("code");
    block.textContent = code.join("\n");
    pre.append(block);
    target.append(pre);
  }
  flushParagraph();
  flushList();
  flushQuote();
}

function renderPromptView(prompt) {
  const isPreview = state.promptView === "preview";
  for (const targetId of ["prompt-text", "prompt-modal-text"]) {
    const target = byId(targetId);
    target.classList.toggle("markdown-source", !isPreview);
    target.classList.toggle("markdown-preview", isPreview);
    if (!isPreview) target.textContent = prompt;
    else renderMarkdown(prompt, target);
  }
  for (const buttonId of ["prompt-preview-button", "prompt-modal-preview-button"]) {
    const button = byId(buttonId);
    button.classList.toggle("is-selected", isPreview);
    button.setAttribute("aria-pressed", String(isPreview));
  }
  for (const buttonId of ["prompt-source-button", "prompt-modal-source-button"]) {
    const button = byId(buttonId);
    button.classList.toggle("is-selected", !isPreview);
    button.setAttribute("aria-pressed", String(!isPreview));
  }
}

function renderWorkspace() {
  const session = state.session;
  if (!session) return;
  const versions = session.versions || [];
  const hasVersions = versions.length > 0;
  const lastMessage = session.messages[session.messages.length - 1];
  const questionCount = session.messages.filter((message) => message.kind === "question").length;
  const isActiveQuestion = lastMessage?.role === "assistant" && lastMessage.kind === "question";

  if (isActiveQuestion && state.answerDraftQuestionId !== lastMessage.id) {
    state.answerDraftQuestionId = lastMessage.id;
    state.selectedAnswerOptions = [];
    state.answerDraftContent = "";
  }

  const latestVersion = versions[0];
  const latestVersionTime = latestVersion ? Date.parse(latestVersion.created_at) : 0;
  const newUserInputs = hasVersions
    ? session.messages.filter((message) => {
      if (message.role !== "user" || !["answer", "feedback"].includes(message.kind)) return false;
      const isNewMessage = Number(latestVersion.source_message_id) > 0
        ? Number(message.id) > Number(latestVersion.source_message_id)
        : Date.parse(message.created_at) > latestVersionTime;
      const wasEditedAfterVersion = message.edited_at && (latestVersion.source_updated_at
        ? Date.parse(message.edited_at) > Date.parse(latestVersion.source_updated_at)
        : Date.parse(message.edited_at) >= latestVersionTime);
      return isNewMessage || wasEditedAfterVersion;
    })
    : [];
  const answerCount = session.messages.filter((message) => message.role === "user" && message.kind === "answer").length;
  const interviewFinished = lastMessage?.role === "assistant" && lastMessage.kind === "notice";
  const completionNoticeIsNew = interviewFinished && (!hasVersions || (
    Number(latestVersion.source_message_id) > 0
      ? Number(lastMessage.id) > Number(latestVersion.source_message_id)
      : Date.parse(lastMessage.created_at) > latestVersionTime
  ));
  const currentGenerationModel = selectedWorkflowModel("generation");
  const previousGenerationModel = latestVersion?.generation_model || (state.modelSettings ? {
    provider: state.modelSettings.provider,
    model: state.modelSettings.providers[state.modelSettings.provider].model || "",
  } : null);
  const generationModelChanged = Boolean(hasVersions && currentGenerationModel && previousGenerationModel && (
    currentGenerationModel.provider !== previousGenerationModel.provider || currentGenerationModel.model !== previousGenerationModel.model
  ));
  const canGenerate = hasVersions
    ? newUserInputs.length > 0 || completionNoticeIsNew || generationModelChanged
    : answerCount > 0 || interviewFinished;
  state.canGenerate = canGenerate;
  const feedbackMode = hasVersions && (
    (isActiveQuestion && state.composerMode === "feedback") ||
    (!isActiveQuestion && lastMessage?.role === "assistant" && lastMessage.kind === "notice")
  );
  const showAnswerComposer = (isActiveQuestion && !feedbackMode) || (
    !hasVersions && lastMessage?.role === "assistant" && lastMessage.kind === "notice"
  );
  const showFeedbackComposer = hasVersions && feedbackMode && lastMessage?.role === "assistant";
  const waitingForModel = lastMessage?.role === "user";

  byId("session-title").textContent = session.title;
  byId("crumb-current").textContent = session.title;
  const currentQuestionNumber = lastMessage?.kind === "question" ? questionCount : questionCount + 1;
  byId("round-label").textContent = "第 " + String(Math.max(1, currentQuestionNumber)).padStart(2, "0") + " 问";
  byId("session-subtitle").textContent = hasVersions
    ? isActiveQuestion
      ? "每轮只处理一个问题；可多选并补充文字，也可切换提交版本意见。"
      : "提交版本意见后会继续访谈；新增回答或意见后，可手动生成下一版。"
    : "每轮回答一个问题；选项可多选，也能补充文字。提交一条回答后即可手动生成第一版。";

  const messageList = byId("message-list");
  // 仅新收到的消息入场，更新模型或界面时不重播历史对话。
  const sameSession = state.renderedSessionId === session.id;
  const previousMessageIds = new Set([...messageList.children].map((node) => node.dataset.messageId));
  const questionOrdinalById = new Map();
  session.messages.forEach((message) => {
    if (message.role === "assistant" && message.kind === "question") {
      questionOrdinalById.set(String(message.id), questionOrdinalById.size + 1);
    }
  });
  let answerOrdinal = 0;
  messageList.replaceChildren(...session.messages.map((message) => {
    const isCurrentMessage = message.id === lastMessage?.id;
    let questionNumber = null;
    if (message.role === "assistant" && message.kind === "question") {
      questionNumber = questionOrdinalById.get(String(message.id));
    } else if (message.role === "user" && message.kind === "answer") {
      answerOrdinal += 1;
      questionNumber = questionOrdinalById.get(String(message.question_id)) || answerOrdinal;
    }
    return makeMessage(message, {
      isNew: sameSession && !previousMessageIds.has(String(message.id)),
      questionNumber,
      isActiveQuestion: isActiveQuestion && isCurrentMessage,
      isFeedbackMode: feedbackMode && isCurrentMessage,
    });
  }));
  state.renderedSessionId = session.id;
  renderQuestionJump(session.messages);
  const scroll = byId("conversation-scroll");
  window.requestAnimationFrame(() => {
    scroll.scrollTop = scroll.scrollHeight;
    updateQuestionJumpActive();
  });

  const composerSlot = byId("composer-slot");
  composerSlot.replaceChildren();
  if (showAnswerComposer && isActiveQuestion) {
    composerSlot.append(createAnswerComposer(lastMessage, hasVersions));
  } else if (showAnswerComposer && lastMessage?.kind === "notice") {
    composerSlot.append(createAnswerComposer({ ...lastMessage, kind: "notice" }, false));
  } else if (showFeedbackComposer) {
    composerSlot.append(state.feedbackCollapsed
      ? createCollapsedFeedback(isActiveQuestion)
      : createFeedbackComposer(isActiveQuestion));
  }

  if (!state.retryMode && !state.suppressAutoRetry && lastMessage?.role === "user") {
    const mode = lastMessage.kind === "initial" ? "initial" : lastMessage.kind === "feedback" ? "refinement" : "answer";
    showRetry("上次的追问还没有完成，可以从已保存的内容继续。", mode);
  } else if (!state.retryMode) {
    byId("retry-row").classList.add("is-hidden");
  }

  const generationAction = byId("generation-action");
  const generateButton = byId("generate-button");
  generationAction.classList.toggle("is-ready", canGenerate);
  generateButton.classList.remove("is-hidden");
  generateButton.disabled = !canGenerate || state.generationPending;
  if (canGenerate && hasVersions && newUserInputs.length > 0) {
    byId("generate-heading").textContent = "V" + String(latestVersion.revision).padStart(2, "0") + " 后有 " + newUserInputs.length + " 条信息更新";
    byId("generate-caption").textContent = "可现在按这些新回答或意见生成下一版，也可以继续回答当前问题。";
  } else if (canGenerate && hasVersions && generationModelChanged) {
    byId("generate-heading").textContent = "已切换生成模型";
    byId("generate-caption").textContent = "可用选定模型重新整理当前需求并评分。";
  } else if (canGenerate && hasVersions) {
    byId("generate-heading").textContent = "当前需求已梳理完成";
    byId("generate-caption").textContent = "访谈员判断现有信息足够；你可以直接生成新版本，也可以提交版本意见。";
  } else if (canGenerate) {
    byId("generate-heading").textContent = "已提交 " + answerCount + " 条回答，可以生成第一版";
    byId("generate-caption").textContent = "确认后才会生成提示词；可选择一起评分，也可以继续访谈再生成。";
  } else if (hasVersions && waitingForModel) {
    byId("generate-heading").textContent = "等本轮追问完成后再继续";
    byId("generate-caption").textContent = "如果模型没有响应，请先重试；新回答或意见保存后可生成下一版。";
  } else if (hasVersions && interviewFinished) {
    byId("generate-heading").textContent = "最新版本已包含当前需求";
    byId("generate-caption").textContent = "如需重新生成，可切换生成模型；要继续完善，请提交版本意见。";
  } else if (hasVersions) {
    byId("generate-heading").textContent = "还没有新的回答或意见";
    byId("generate-caption").textContent = "回答当前问题，或提交版本意见；新内容保存后才可生成下一版。";
  } else {
    byId("generate-heading").textContent = "先回答第一个问题";
    byId("generate-caption").textContent = "提交一条回答后，这里才会开放第一版生成。";
  }
  if (canGenerate && !hasVersions && interviewFinished) {
    byId("generate-heading").textContent = "需求已梳理完成，可以生成第一版";
    byId("generate-caption").textContent = "访谈员判断当前信息足够；你也可以继续补充，再手动生成。";
  }
  renderWorkflowModelSelectors();
  byId("generate-button-label").textContent = "生成提示词";
  byId("version-count").textContent = hasVersions ? String(versions.length).padStart(2, "0") + " 个版本" : "尚未生成";
  byId("result-zoom-button").classList.remove("is-hidden");
  byId("empty-result").classList.toggle("is-hidden", hasVersions);
  byId("result-content").classList.toggle("is-hidden", !hasVersions);
  if (!state.retryMode) {
    if (isActiveQuestion && feedbackMode) byId("session-state-label").textContent = "正在提交版本意见";
    else if (isActiveQuestion) byId("session-state-label").textContent = "等你回答";
    else if (lastMessage?.kind === "notice") byId("session-state-label").textContent = hasVersions ? "可提交意见" : "可补充信息";
    else if (lastMessage?.kind === "initial") byId("session-state-label").textContent = "正在准备首个问题";
    else if (waitingForModel) byId("session-state-label").textContent = "等待模型追问";
    else byId("session-state-label").textContent = hasVersions ? "可继续迭代" : "需求梳理中";
  }
  byId("empty-result-tag").textContent = canGenerate ? "准备就绪" : "尚未生成";
  byId("empty-result-title").textContent = "提示词还未生成";
  byId("empty-result-copy").textContent = canGenerate
    ? "使用上方按钮生成；生成后会在这里显示提示词、评分和完善说明。"
    : "生成后会在这里显示提示词、评分和完善说明。";
  if (hasVersions) renderVersionPanel(getSelectedVersion());
  renderInterviewPreview();
  updateWorkspaceView();
}

function setWorkspaceView(view) {
  const changed = state.workspaceView !== view;
  state.workspaceView = view;
  updateWorkspaceView();
  byId("result-column").scrollTop = 0;
  if (changed) revealElement(view === "interview" ? byId("interview-preview") : view === "evaluation" ? byId("evaluation-action") : byId("result-content"));
}

function updateWorkspaceView() {
  const view = state.workspaceView;
  document.querySelector(".workspace-tabs").style.setProperty("--tab-index", ["interview", "prompt", "evaluation"].indexOf(view));
  const hasVersions = Boolean(state.session?.versions.length);
  for (const name of ["interview", "prompt", "evaluation"]) {
    const tab = byId(`${name}-tab`);
    tab.setAttribute("aria-selected", String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
  }
  byId("interview-preview").classList.toggle("is-hidden", view !== "interview");
  byId("generation-action").classList.toggle("is-hidden", view !== "interview");
  byId("evaluation-action").classList.toggle("is-hidden", view !== "evaluation");
  byId("version-history").classList.toggle("is-hidden", view === "interview" || !hasVersions);
  byId("empty-result").classList.toggle("is-hidden", view === "interview" || hasVersions);
  byId("result-content").classList.toggle("is-hidden", view === "interview" || !hasVersions);
  document.querySelector(".prompt-card").classList.toggle("is-hidden", view !== "prompt");
  document.querySelector(".notes-card").classList.toggle("is-hidden", view !== "prompt");
  byId("score-card").classList.toggle("is-hidden", view !== "evaluation");
  const conversationPending = byId("conversation-thinking").getAttribute("aria-busy") === "true";
  const modelPending = state.generationPending || state.evaluationPending || state.feedbackPending || conversationPending;
  byId("evaluate-button").disabled = !hasVersions || modelPending;
  byId("generate-button").disabled = modelPending;
  const answerSubmit = byId("answer-form")?.querySelector('button[type="submit"]');
  if (answerSubmit) answerSubmit.disabled = modelPending || (!state.selectedAnswerOptions.length && !state.answerDraftContent.trim());
  const feedbackSubmit = byId("feedback-form")?.querySelector('button[type="submit"]');
  if (feedbackSubmit) feedbackSubmit.disabled = modelPending;
  if (!state.generationPending) byId("generate-button-label").textContent = "生成提示词";
  byId("confirm-generation-button").disabled = !state.canGenerate || modelPending;
  byId("confirm-evaluation-button").disabled = !hasVersions || modelPending;
  if (!hasVersions) {
    byId("empty-result-tag").textContent = "先访谈，再生成";
    byId("empty-result-title").textContent = view === "evaluation" ? "先生成一版提示词" : "提示词还未生成";
    byId("empty-result-copy").textContent = "在需求清单中核对已收集的内容，满足条件后手动生成；随后可在评估页独立评分。";
  }
}

function renderInterviewPreview() {
  const list = byId("interview-preview-list");
  list.replaceChildren();
  const answersByQuestion = new Map();
  let latestQuestionId = null;
  for (const message of state.session.messages) {
    if (message.kind === "question") latestQuestionId = String(message.id);
    if (message.kind !== "answer") continue;
    const key = message.question_id ? String(message.question_id) : latestQuestionId;
    if (!key) continue;
    if (!answersByQuestion.has(key)) answersByQuestion.set(key, []);
    answersByQuestion.get(key).push(message);
  }
  const questions = state.session.messages.filter((message) => message.kind === "question");
  const answeredCount = questions.filter((message) => answersByQuestion.has(String(message.id))).length;
  byId("preview-answer-count").textContent = `${answeredCount} / ${questions.length} 已回答`;
  for (const button of document.querySelectorAll("[data-preview-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.previewFilter === state.previewFilter));
    button.textContent = button.dataset.previewFilter === "all" ? "全部" : button.dataset.previewFilter === "answered" ? "已回答" : `待回答 ${questions.length - answeredCount}`;
  }
  const returnToConversation = () => {
    if (byId("focus-dialog").open && byId("result-column").closest("#focus-dialog")) byId("focus-dialog-close").click();
  };
  const rememberExpansion = (details, key, body) => {
    details.open = state.previewExpanded.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) { state.previewExpanded.add(key); revealElement(body); }
      else state.previewExpanded.delete(key);
    });
  };
  if (state.previewFilter === "all") {
    const context = document.createElement("details");
    context.className = "preview-context";
    const summary = document.createElement("summary");
    summary.textContent = "原始需求与反馈";
    const body = document.createElement("div");
    for (const message of state.session.messages.filter((item) => !["question", "answer"].includes(item.kind))) {
      const label = document.createElement("strong");
      label.textContent = message.kind === "initial" ? "原始需求" : message.kind === "feedback" ? "修改意见" : "访谈小结";
      const text = document.createElement("p");
      text.textContent = message.content;
      body.append(label, text);
    }
    context.append(summary, body);
    rememberExpansion(context, "context", body);
    list.append(context);
  }
  questions.forEach((message, index) => {
    const answers = answersByQuestion.get(String(message.id)) || [];
    if ((state.previewFilter === "answered" && !answers.length) || (state.previewFilter === "pending" && answers.length)) return;
    const article = document.createElement("details");
    article.className = `requirement-item${answers.length ? " is-answered" : " is-pending"}`;
    const summary = document.createElement("summary");
    const number = document.createElement("span");
    number.className = "requirement-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "requirement-copy";
    const title = document.createElement("strong");
    title.textContent = message.content;
    const snippet = document.createElement("span");
    if (answers.length) {
      const answer = parseAnswerContent(answers[answers.length - 1].content);
      snippet.textContent = [...answer.selectedOptions, answer.content].filter(Boolean).join("；");
    } else snippet.textContent = "待回答";
    copy.append(title, snippet);
    const status = document.createElement("span");
    status.className = "requirement-status";
    status.textContent = answers.length ? "✓" : "○";
    status.setAttribute("aria-label", answers.length ? "已回答" : "待回答");
    summary.append(number, copy, status);
    const body = document.createElement("div");
    body.className = "requirement-body";
    summary.addEventListener("click", () => {
      if (article.open) return;
      returnToConversation();
      const target = [...byId("message-list").children].find((node) => node.dataset.messageId === String(message.id));
      target?.scrollIntoView({ block: "center", behavior: "auto" });
      if (target) revealElement(target);
    });
      for (const answer of answers) {
        const record = document.createElement("div");
        record.className = "interview-record-answer";
        renderAnswerRecord(record, answer);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-button";
        edit.textContent = "修改这条回答 ↗";
        edit.addEventListener("click", () => {
          returnToConversation();
          const target = [...byId("message-list").children].find((node) => node.dataset.messageId === String(answer.id));
          const button = target?.querySelector(".message-edit-button");
          if (button?.getAttribute("aria-expanded") !== "true") button?.click();
          target?.scrollIntoView({ block: "start", behavior: "auto" });
          target?.querySelector("textarea")?.focus({ preventScroll: true });
        });
        body.append(record, edit);
      }
      if (!answers.length) {
        const pending = document.createElement("p");
        pending.className = "interview-record-pending";
        pending.textContent = "在左侧回答这道问题，内容保存后会显示在清单中。";
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "text-button";
        jump.textContent = "去回答 ↗";
        jump.addEventListener("click", () => {
          returnToConversation();
          const target = [...byId("message-list").children].find((node) => node.dataset.messageId === String(message.id));
          target?.scrollIntoView({ block: "center", behavior: "auto" });
          byId("answer-input")?.focus({ preventScroll: true });
        });
        body.append(pending, jump);
      }
      if (message.suggested_answers?.length) {
        const options = createQuestionOptionsPreview(message);
        if (options) body.append(options);
      }
    article.append(summary, body);
    rememberExpansion(article, String(message.id), body);
    list.append(article);
  });
  if (!list.children.length) {
    const empty = document.createElement("p");
    empty.className = "preview-filter-empty";
    empty.textContent = state.previewFilter === "pending" ? "当前没有待回答的问题，可继续补充需求或生成提示词。" : "还没有已保存的回答。";
    list.append(empty);
  }
}
function updateScoreCollapse() {
  const collapsed = state.scoreCollapsed;
  const wasHidden = byId("score-card-body").hidden;
  byId("score-card").classList.toggle("is-collapsed", collapsed);
  byId("score-card-body").hidden = collapsed;
  if (wasHidden && !collapsed) revealElement(byId("score-card-body"));
  byId("score-collapse-button").textContent = collapsed ? "展开" : "收起";
  byId("score-collapse-button").setAttribute("aria-expanded", String(!collapsed));
  byId("score-collapsed-summary").textContent = `${byId("overall-score").textContent}/100`;
  byId("score-collapsed-summary").classList.toggle("is-hidden", !collapsed);
}

function updateHistoryCollapse() {
  const collapsed = state.historyCollapsed;
  const wasHidden = byId("version-history-body").hidden;
  byId("version-history").classList.toggle("is-collapsed", collapsed);
  byId("version-history-body").hidden = collapsed;
  if (wasHidden && !collapsed) revealElement(byId("version-history-body"));
  byId("version-history-toggle").textContent = collapsed ? "展开" : "收起";
  byId("version-history-toggle").setAttribute("aria-expanded", String(!collapsed));
  const count = state.session?.versions?.length || 0;
  byId("version-history-summary").textContent = collapsed ? `${count} 个版本` : "";
  byId("version-history-summary").classList.toggle("is-hidden", !collapsed);
}

function renderVersionPanel(version) {
  if (!version) return;
  const evaluations = version.evaluations || [];
  const evaluation = state.selectedEvaluationId === "initial" ? null : evaluations.find((item) => item.id === state.selectedEvaluationId) || evaluations[0];
  const report = evaluation || version;
  const hasScore = typeof report.overall_score === "number";
  const resultContent = byId("result-content");
  const versionKey = `${state.session.id}:${version.id}`;
  const versionChanged = resultContent.dataset.versionKey !== versionKey;
  resultContent.dataset.versionKey = versionKey;
  byId("overall-score").textContent = hasScore ? String(report.overall_score) : "—";
  const reportModel = evaluation?.model || version.evaluation_model || version.generation_model;
  byId("evaluation-source").textContent = hasScore ? `${evaluation ? "独立评审" : "生成时评分"} · ${reportModel?.model || "历史模型未记录"} · ${displayDateTime(evaluation?.created_at || version.created_at)}` : "本版尚未评分，可选择评审模型后单独评分。";
  const evaluationHistory = byId("evaluation-history");
  evaluationHistory.replaceChildren();
  const reports = [
    ...(typeof version.overall_score === "number" ? [{ id: "initial", label: `生成时 · ${version.overall_score} 分` }] : []),
    ...evaluations.map((item, index) => ({ id: item.id, label: `评审 ${evaluations.length - index} · ${item.overall_score} 分` })),
  ];
  for (const item of reports) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "evaluation-report-button";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", String(item.id === (evaluation?.id || "initial")));
    button.addEventListener("click", () => { state.selectedEvaluationId = item.id; renderVersionPanel(version); });
    evaluationHistory.append(button);
  }
  byId("evaluation-notes").textContent = evaluation?.improvement_notes || "";
  byId("score-stamp").textContent = `V${String(version.revision).padStart(2, "0")}`;
  byId("prompt-version-number").textContent = String(version.revision).padStart(2, "0");
  byId("prompt-created-at").textContent = displayDateTime(version.created_at);
  byId("evaluation-target").textContent = `评估已有提示词 · V${String(version.revision).padStart(2, "0")}`;
  byId("prompt-preview-version").textContent = `V${String(version.revision).padStart(2, "0")}`;
  byId("prompt-preview-footer-version").textContent = String(version.revision).padStart(2, "0");
  renderPromptView(version.prompt);
  updateScoreCollapse();
  updateHistoryCollapse();
  byId("improvement-notes").textContent = version.improvement_notes || "本次完善已整理为可直接使用的提示词。";

  const dimensions = byId("dimension-list");
  dimensions.replaceChildren();
  const dimensionItems = report.dimensions || [];
  document.querySelector(".score-radar-figure").classList.toggle("is-hidden", !hasScore);
  for (const item of dimensionItems) {
    const row = document.createElement("div");
    row.className = "dimension-row";
    const name = document.createElement("span");
    name.className = "dimension-name";
    name.textContent = item.name;
    const score = document.createElement("b");
    score.className = "dimension-score";
    score.textContent = String(item.score);
    row.title = item.note || "";
    row.append(name, score);
    const track = document.createElement("span");
    track.className = "dimension-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "dimension-fill";
    fill.style.width = `${Math.max(0, Math.min(100, Number(item.score) || 0))}%`;
    track.append(fill);
    row.append(track);
    dimensions.append(row);
  }

  const radar = byId("score-radar");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const center = { x: 160, y: 118 };
  const radius = 84;
  const shortLabels = {
    "目标清晰度": "目标",
    "背景完整度": "背景",
    "受众与场景适配度": "受众与场景",
    "约束覆盖度": "约束",
    "输出要求明确度": "输出要求",
    "可执行性与验收标准": "可执行性",
  };
  const axes = dimensionItems.map((item, index) => ({
    name: item.name,
    label: shortLabels[item.name] || item.name,
    angle: -90 + (360 * index / Math.max(1, dimensionItems.length)),
  }));
  document.querySelector(".score-radar-hint").textContent = axes.length < 6
    ? `该历史评分记录了 ${axes.length} 项；重新评分可获得六项维度。分数越高越靠近外圈。`
    : "每个方向代表一项评分，分数越高越靠近外圈";
  const pointsAt = (scale) => axes.map((axis) => {
    const radians = axis.angle * Math.PI / 180;
    return {
      x: center.x + Math.cos(radians) * radius * scale,
      y: center.y + Math.sin(radians) * radius * scale,
    };
  });
  const toPointString = (points) => points.map((point) => `${point.x},${point.y}`).join(" ");
  const addSvgElement = (tagName, attributes, textContent = "") => {
    const element = document.createElementNS(svgNamespace, tagName);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    if (textContent) element.textContent = textContent;
    radar.append(element);
    return element;
  };
  radar.replaceChildren();
  const title = document.createElementNS(svgNamespace, "title");
  title.textContent = `提示词${axes.length}项评分雷达图`;
  radar.append(title);
  for (const level of [0.25, 0.5, 0.75, 1]) {
    addSvgElement("polygon", { points: toPointString(pointsAt(level)), class: "score-radar-grid" });
  }
  for (const point of pointsAt(1)) {
    addSvgElement("line", { x1: center.x, y1: center.y, x2: point.x, y2: point.y, class: "score-radar-axis" });
  }
  const scoresByName = new Map(dimensionItems.map((item) => [item.name, Math.max(0, Math.min(100, Number(item.score) || 0))]));
  const scorePoints = axes.map((axis) => {
    const radians = axis.angle * Math.PI / 180;
    const score = scoresByName.get(axis.name) || 0;
    return {
      x: center.x + Math.cos(radians) * radius * score / 100,
      y: center.y + Math.sin(radians) * radius * score / 100,
    };
  });
  addSvgElement("polygon", { points: toPointString(scorePoints), class: "score-radar-area" });
  scorePoints.forEach((point) => addSvgElement("circle", {
    cx: point.x,
    cy: point.y,
    r: 3.5,
    class: "score-radar-point",
  }));
  const labelRadius = radius + 22;
  for (const axis of axes) {
    const radians = axis.angle * Math.PI / 180;
    const x = center.x + Math.cos(radians) * labelRadius;
    const y = center.y + Math.sin(radians) * labelRadius + (Math.sin(radians) > 0.65 ? 4 : 0);
    const anchor = Math.cos(radians) > 0.2 ? "start" : Math.cos(radians) < -0.2 ? "end" : "middle";
    addSvgElement("text", { x, y, class: "score-radar-label", "text-anchor": anchor }, axis.label);
  }

  const versionList = byId("version-list");
  versionList.replaceChildren();
  for (const item of state.session.versions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `version-pill${item.id === version.id ? " is-selected" : ""}`;
    const number = document.createElement("b");
    number.textContent = `V${String(item.revision).padStart(2, "0")}`;
    const scoreLabel = document.createElement("span");
    scoreLabel.textContent = typeof item.overall_score === "number" ? `${item.overall_score} 分` : "待评分";
    button.title = `第 ${item.revision} 版。点击查看该版提示词及评分记录。`;
    button.setAttribute("aria-label", `查看第 ${item.revision} 版${typeof item.overall_score === "number" ? `，评分 ${item.overall_score} 分` : "，待评分"}`);
    button.append(number, scoreLabel);
    button.addEventListener("click", () => {
      state.selectedVersionId = item.id;
      state.selectedEvaluationId = null;
      renderVersionPanel(item);
    });
    versionList.append(button);
  }
  if (versionChanged) {
    revealElement(document.querySelector(".prompt-card"));
    revealElement(byId("score-card"), 70);
    revealElement(document.querySelector(".notes-card"), 120);
    for (const fill of dimensions.querySelectorAll(".dimension-fill")) {
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && typeof fill.animate === "function") {
        fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 650, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }
  }
}

async function startSession(initialRequest) {
  const button = byId("initial-form").querySelector("button[type=submit]");
  setBusy(button, true, "正在建立…");
  try {
    const session = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ initial_request: initialRequest })
    });
    state.session = session;
    state.selectedVersionId = null;
    state.feedbackCollapsed = false;
    state.activeQuestionId = null;
    state.suppressAutoRetry = true;
    renderWorkspace();
    state.suppressAutoRetry = false;
    hideRetry();
    setWorkspaceVisible(true);
    await refreshSessions();
    await askNext("initial");
  } catch (error) {
    if (error.status === 502 && state.session) {
      showRetry(error.message, "initial");
    } else {
      showToast(error.message);
    }
  } finally {
    setBusy(button, false);
  }
}

async function askNext(mode) {
  if (!state.session || state.askNextPending || state.generationPending || state.evaluationPending || state.feedbackPending) return;
  state.askNextPending = true;
  hideRetry();
  setConversationThinking(true, mode === "answer" ? "answer-retry" : mode);
  try {
    await request(`/api/sessions/${state.session.id}/ask-next`, {
      method: "POST",
      body: JSON.stringify({ refinement_mode: mode === "refinement" })
    });
    hideRetry();
    await loadSession(state.session.id);
    await refreshSessions();
  } catch (error) {
    const retryMode = mode === "initial" ? "initial" : mode === "refinement" ? "refinement" : "answer";
    showRetry(error.message, retryMode);
  } finally {
    state.askNextPending = false;
    setConversationThinking(false, mode);
  }
}

async function submitAnswer(event) {
  event.preventDefault();
  if (!state.session || state.generationPending || state.evaluationPending || state.feedbackPending || event.currentTarget.getAttribute("aria-busy") === "true") return;
  const form = event.currentTarget;
  const input = byId("answer-input");
  const content = input.value.trim();
  const selectedOptions = [...state.selectedAnswerOptions];
  if (!content && !selectedOptions.length) {
    showToast("请选择一个或多个方向，或填写补充说明。");
    input.focus();
    return;
  }

  const previousMessageIds = new Set(state.session.messages.map((message) => String(message.id)));
  const expectedContent = answerMessageContent(content, selectedOptions);
  byId("session-state-label").textContent = "正在理解你的回答";
  setComposerThinking(form, true);
  try {
    await request("/api/sessions/" + state.session.id + "/turn", {
      method: "POST",
      body: JSON.stringify({ content, selected_options: selectedOptions })
    });
    state.answerDraftContent = "";
    state.selectedAnswerOptions = [];
    state.pendingAnswerCheck = null;
    state.composerMode = null;
    hideRetry();
    await loadSession(state.session.id);
    await refreshSessions();
  } catch (error) {
    if (error.status === 502) {
      state.answerDraftContent = "";
      state.selectedAnswerOptions = [];
      state.pendingAnswerCheck = null;
      state.composerMode = null;
      await loadSession(state.session.id).catch(() => {});
      showRetry(`回答已保存，但模型没能生成下一问。原因：${error.message || "模型服务暂时无法完成请求"} 修复模型设置或服务后，点“重试访谈”即可继续；回答不会重复提交。`, "answer");
    } else if (error.status === null || error.status >= 500) {
      state.pendingAnswerCheck = { expectedContent, previousMessageIds: [...previousMessageIds] };
      await checkAnswerSubmission();
    } else {
      byId("session-state-label").textContent = "等你回答";
      showToast(`回答没有提交：${error.message} 输入内容仍保留，请修正后重新提交。`);
    }
  } finally {
    setComposerThinking(form, false);
  }
}

function setComposerThinking(form, isThinking) {
  form.setAttribute("aria-busy", String(isThinking));
  form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = isThinking; });
  if (!isThinking) {
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !state.selectedAnswerOptions.length && !state.answerDraftContent.trim();
  }
  setConversationThinking(isThinking, "answer");
}

function setConversationThinking(isThinking, mode = "answer") {
  const indicator = byId("conversation-thinking");
  const copyByMode = {
    initial: {
      title: "正在请求模型生成第一道问题",
      detail: "初始需求已保存，正在等待模型返回澄清问题。",
    },
    answer: {
      title: "正在提交本轮回答",
      detail: "提交后会请求模型结合已有信息生成下一问。",
    },
    "answer-retry": {
      title: "正在重新请求下一问",
      detail: "已保存的回答会继续保留，不会再次提交。",
    },
    refinement: {
      title: "正在重新检查版本意见",
      detail: "已保存的修改意见会保留，模型正在判断是否需要追问。",
    },
  };
  const copy = copyByMode[mode] || copyByMode.answer;
  byId("conversation-thinking-title").textContent = copy.title;
  byId("conversation-thinking-detail").textContent = copy.detail;
  window.clearInterval(state.conversationThinkingTimer);
  state.conversationThinkingTimer = null;
  indicator.classList.toggle("is-hidden", !isThinking);
  indicator.setAttribute("aria-hidden", String(!isThinking));
  indicator.setAttribute("aria-busy", String(isThinking));
  byId("session-state").classList.toggle("is-hidden", isThinking);
  if (isThinking) {
    state.conversationThinkingStartedAt = Date.now();
    const updateElapsed = () => {
      const seconds = Math.floor((Date.now() - state.conversationThinkingStartedAt) / 1000);
      const status = seconds >= 15 ? "模型响应较慢" : "等待模型响应";
      byId("conversation-thinking-elapsed").textContent = `${status} · 已等待 ${seconds} 秒`;
    };
    updateElapsed();
    state.conversationThinkingTimer = window.setInterval(updateElapsed, 1000);
    window.requestAnimationFrame(() => {
      const scroll = byId("conversation-scroll");
      scroll.scrollTop = scroll.scrollHeight;
    });
  } else {
    state.conversationThinkingStartedAt = 0;
  }
  if (state.session) updateWorkspaceView();
}

function answerMessageContent(content, selectedOptions) {
  const parts = [];
  if (selectedOptions.length) parts.push("选择的选项：\n" + selectedOptions.map((option) => `- ${option}`).join("\n"));
  if (content) parts.push(selectedOptions.length ? "补充说明：\n" + content : content);
  return parts.join("\n\n");
}

async function checkAnswerSubmission() {
  if (!state.session || !state.pendingAnswerCheck) return;
  const pending = state.pendingAnswerCheck;
  try {
    const session = await request(`/api/sessions/${state.session.id}`);
    const previousIds = new Set(pending.previousMessageIds);
    const saved = session.messages.some((message) =>
      !previousIds.has(String(message.id)) &&
      message.role === "user" && message.kind === "answer" &&
      message.content === pending.expectedContent
    );
    state.session = session;
    state.pendingAnswerCheck = null;
    if (saved) {
      state.answerDraftContent = "";
      state.selectedAnswerOptions = [];
      state.composerMode = null;
      renderWorkspace();
      setWorkspaceVisible(true);
      renderSessionList();
      await refreshSessions();
      const lastMessage = session.messages[session.messages.length - 1];
      if (lastMessage?.role === "assistant" && lastMessage.kind === "question") {
        showToast("回答已保存，下一轮问题也已收到。可以继续回答。");
      } else {
        showRetry("回答已保存，但刚才没有收到模型的提问。检查模型连接后，点“重试访谈”继续。", "answer");
      }
    } else {
      hideRetry();
      renderWorkspace();
      setWorkspaceVisible(true);
      showToast("暂时没有查到这条回答已保存。草稿还在输入框中，可以重新提交。");
    }
  } catch {
    showRetry("暂时无法确认回答是否已保存。草稿仍保留；请检查浏览器本地存储后点击“检查回答状态”，先确认记录再重试。", "answer-check");
  }
}

async function submitFeedback(event) {
  event.preventDefault();
  if (!state.session || state.generationPending || state.evaluationPending || state.feedbackPending || byId("conversation-thinking").getAttribute("aria-busy") === "true") return;
  const form = event.currentTarget;
  const input = byId("feedback-input");
  const content = input.value.trim();
  if (!content) {
    input.focus();
    return;
  }
  const button = form.querySelector("button[type=submit]");
  state.feedbackPending = true;
  updateWorkspaceView();
  setBusy(button, true, "正在整理意见…");
  try {
    await request("/api/sessions/" + state.session.id + "/refine", {
      method: "POST",
      body: JSON.stringify({ content })
    });
    state.feedbackDraftContent = "";
    state.feedbackCollapsed = false;
    state.composerMode = null;
    hideRetry();
    await loadSession(state.session.id);
    await refreshSessions();
  } catch (error) {
    if (error.status === 502) {
      state.feedbackDraftContent = "";
      state.feedbackCollapsed = false;
      state.composerMode = null;
      await loadSession(state.session.id).catch(() => {});
      showRetry(error.message, "refinement");
    } else {
      showToast(error.message);
    }
  } finally {
    state.feedbackPending = false;
    setBusy(button, false);
    if (state.session) updateWorkspaceView();
  }
}
async function generatePrompt() {
  if (!state.session || state.generationPending || state.evaluationPending || state.feedbackPending || byId("conversation-thinking").getAttribute("aria-busy") === "true") return;
  const sessionId = state.session.id;
  state.generationPending = true;
  updateWorkspaceView();
  const includeScore = byId("include-generation-score").checked;
  const button = byId("generate-button");
  const action = byId("generation-action");
  action.classList.add("is-generating");
  button.classList.add("is-generating");
  setBusy(button, true, includeScore ? "正在生成并评分…" : "正在生成提示词…");
  hideRetry();
  try {
    const result = await request(`/api/sessions/${sessionId}/generate`, { method: "POST", body: JSON.stringify({ include_score: includeScore }) });
    if (state.session?.id !== sessionId) { await refreshSessions(); return; }
    state.selectedVersionId = result.version.id;
    state.selectedEvaluationId = null;
    state.workspaceView = "prompt";
    await loadSession(sessionId);
    await refreshSessions();
    showToast(`版本 ${String(result.version.revision).padStart(2, "0")} 已保存。`);
  } catch (error) {
    if (error.status === 502) showRetry(error.message, "generate");
    else showToast(error.message);
  } finally {
    state.generationPending = false;
    setBusy(button, false);
    button.classList.remove("is-generating");
    action.classList.remove("is-generating");
    if (state.session) updateWorkspaceView();
  }
}

async function evaluatePrompt() {
  const version = getSelectedVersion();
  if (!state.session || !version || state.evaluationPending || state.generationPending || state.feedbackPending || byId("conversation-thinking").getAttribute("aria-busy") === "true") return;
  const sessionId = state.session.id;
  state.evaluationPending = true;
  updateWorkspaceView();
  const button = byId("evaluate-button");
  setBusy(button, true, "正在独立评分…");
  byId("evaluation-action").classList.add("is-evaluating");
  byId("evaluation-status").textContent = `正在等待评审模型评估 V${String(version.revision).padStart(2, "0")}…`;
  try {
    const result = await request(`/api/sessions/${sessionId}/versions/${version.id}/evaluate`, { method: "POST" });
    if (state.session?.id !== sessionId) { await refreshSessions(); return; }
    state.selectedEvaluationId = result.evaluation.id;
    await loadSession(sessionId);
    await refreshSessions();
    byId("evaluation-status").textContent = `V${String(version.revision).padStart(2, "0")} 评分已保存，原提示词未改动。`;
  } catch (error) {
    byId("evaluation-status").textContent = `评分未完成：${error.message} 可以重试；原提示词和已有评分仍保留。`;
  } finally {
    state.evaluationPending = false;
    setBusy(button, false);
    byId("evaluation-action").classList.remove("is-evaluating");
    if (state.session) updateWorkspaceView();
  }
}

async function retryCurrentAction() {
  const mode = state.retryMode;
  if (!mode || !state.session) return;
  hideRetry();
  if (mode === "generate") {
    await generatePrompt();
    return;
  }
  if (mode === "answer-check") {
    await checkAnswerSubmission();
    return;
  }
  await askNext(mode === "initial" ? "initial" : mode === "refinement" ? "refinement" : "answer");
}

function populateProviderFields(provider) {
  if (!state.modelSettings) return;
  const config = state.modelSettings.providers[provider];
  byId("openai-fields").classList.toggle("is-hidden", provider !== "openai");
  byId("ollama-fields").classList.toggle("is-hidden", provider !== "ollama");
  if (provider === "openai") {
    byId("openai-model").value = config.model || "";
    byId("openai-base-url").value = config.base_url || "";
    byId("openai-api-key").value = "";
    byId("openai-key-state").textContent = config.api_key_configured ? "已保存，留空沿用" : "未配置";
  } else {
    byId("ollama-model").value = config.model || "";
    byId("ollama-base-url").value = config.base_url || "";
  }
}

function renderModelChip() {
  if (!state.modelSettings) return;
  const provider = state.modelSettings.provider;
  const config = state.modelSettings.providers[provider];
  const ready = provider === "ollama" || config.api_key_configured;
  byId("model-chip").classList.toggle("is-configured", ready);
  const providerLabel = provider === "ollama" ? "Ollama" : "OpenAI 兼容";
  byId("model-chip-label").textContent = `${providerLabel} · ${config.model || "未填写模型"}`;
}

function renderWorkflowModelSelectors() {
  if (!state.modelSettings) return;
  const settings = state.modelSettings;
  for (const [workflow, id] of [["interview", "interview-model-select"], ["generation", "generation-model-select"], ["evaluation", "evaluation-model-select"]]) {
    const select = byId(id);
    const savedChoice = settings.workflow_models?.[workflow] || { provider: "", model: "" };
    const selectedProvider = savedChoice.provider || settings.provider;
    const selectedValue = savedChoice.model ? JSON.stringify([selectedProvider, savedChoice.model]) : "";
    select.replaceChildren();

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    const defaultProviderLabel = settings.provider === "ollama" ? "Ollama" : "OpenAI 兼容";
    defaultOption.textContent = `默认 · ${defaultProviderLabel} · ${settings.providers[settings.provider].model || "未填写"}`;
    select.title = "可在顶部模型设置中获取可用模型列表，再按用途选择。";
    select.append(defaultOption);

    for (const provider of ["openai", "ollama"]) {
      const config = settings.providers[provider];
      const models = new Set(state.modelLists[provider] || []);
      if (config.model) models.add(config.model);
      if (selectedProvider === provider && savedChoice.model) models.add(savedChoice.model);
      if (!models.size) continue;
      const group = document.createElement("optgroup");
      group.label = provider === "openai" ? "OpenAI 兼容接口" : "Ollama";
      for (const model of [...models].sort((left, right) => left.localeCompare(right))) {
        const option = document.createElement("option");
        option.value = JSON.stringify([provider, model]);
        option.textContent = model;
        group.append(option);
      }
      select.append(group);
    }
    select.value = selectedValue;
    const choice = selectedWorkflowModel(workflow);
    const button = byId(`${workflow}-model-button`);
    button.replaceChildren();
    const modelName = document.createElement("strong");
    modelName.textContent = choice.model || "未填写模型";
    const service = document.createElement("small");
    service.textContent = `${savedChoice.model ? "" : "默认 · "}${choice.provider === "ollama" ? "Ollama 本地" : "OpenAI 兼容"}`;
    const copy = document.createElement("span");
    copy.append(modelName, service);
    const arrow = document.createElement("span");
    arrow.className = "workflow-picker-arrow";
    arrow.textContent = "⌄";
    arrow.setAttribute("aria-hidden", "true");
    button.append(copy, arrow);
    button.title = `${modelName.textContent} · ${service.textContent}，点击切换`;
  }
}

function selectedWorkflowModel(workflow) {
  const settings = state.modelSettings;
  if (!settings) return null;
  const choice = settings.workflow_models?.[workflow] || { provider: "", model: "" };
  const provider = choice.provider || settings.provider;
  return { provider, model: choice.model || settings.providers[provider].model || "" };
}

function openWorkflowPicker(workflow) {
  state.pickerWorkflow = workflow;
  byId("workflow-picker-title").textContent = `选择${{ interview: "访谈", generation: "生成", evaluation: "评审" }[workflow]}模型`;
  byId("workflow-model-search").value = "";
  byId("workflow-custom-model").value = "";
  byId("workflow-custom-provider").value = selectedWorkflowModel(workflow)?.provider || "openai";
  renderWorkflowPicker();
  byId("workflow-picker-dialog").showModal();
  byId("workflow-model-search").focus();
}

function renderWorkflowPicker() {
  const select = byId(`${state.pickerWorkflow}-model-select`);
  const query = byId("workflow-model-search").value.trim().toLowerCase();
  const list = byId("workflow-model-options");
  list.replaceChildren();
  let previousGroup = "";
  for (const option of select.options) {
    const group = option.parentElement.tagName === "OPTGROUP" ? option.parentElement.label : "默认设置";
    if (query && !`${group} ${option.textContent}`.toLowerCase().includes(query)) continue;
    if (group !== previousGroup) {
      const heading = document.createElement("h3");
      heading.textContent = group;
      list.append(heading);
      previousGroup = group;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-model-option";
    button.setAttribute("aria-pressed", String(option.value === select.value));
    const name = document.createElement("strong");
    name.textContent = option.value ? option.textContent : "沿用默认模型";
    const caption = document.createElement("small");
    caption.textContent = option.value ? group : option.textContent;
    button.append(name, caption);
    button.addEventListener("click", () => chooseWorkflowModel(option.value));
    list.append(button);
  }
  if (!list.children.length) {
    const empty = document.createElement("p");
    empty.textContent = "没有匹配的模型。可自定义输入，或在模型连接中获取列表。";
    list.append(empty);
  }
}

async function chooseWorkflowModel(value) {
  const workflow = state.pickerWorkflow;
  const select = byId(`${workflow}-model-select`);
  if (select.disabled) return;
  if (value && ![...select.options].some((item) => item.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = JSON.parse(value)[1];
    select.append(option);
  }
  select.value = value;
  const dialog = byId("workflow-picker-dialog");
  dialog.setAttribute("aria-busy", "true");
  dialog.querySelectorAll("button, input, select").forEach((control) => { control.disabled = true; });
  try {
    if (await saveWorkflowModel(workflow, select)) dialog.close();
  } finally {
    dialog.setAttribute("aria-busy", "false");
    dialog.querySelectorAll("button, input, select").forEach((control) => { control.disabled = false; });
  }
}

function renderWorkspaceKeepingScroll() {
  if (!state.session) return;
  const scroll = byId("conversation-scroll");
  const scrollTop = scroll.scrollTop;
  renderWorkspace();
  window.requestAnimationFrame(() => {
    scroll.scrollTop = scrollTop;
    updateQuestionJumpActive();
  });
}

async function saveWorkflowModel(workflow, select) {
  if (!state.modelSettings) return;
  let choice = { provider: "", model: "" };
  if (select.value) {
    try {
      const [provider, model] = JSON.parse(select.value);
      if (["openai", "ollama"].includes(provider) && typeof model === "string") choice = { provider, model };
    } catch {
      select.value = "";
      return;
    }
  }
  const previousSettings = state.modelSettings;
  const workflowModels = { ...previousSettings.workflow_models, [workflow]: choice };
  select.disabled = true;
  try {
    state.modelSettings = await request("/api/settings/model", {
      method: "PUT",
      body: JSON.stringify({ provider: previousSettings.provider, workflow_models: workflowModels }),
    });
    renderWorkflowModelSelectors();
    if (workflow === "generation") renderWorkspaceKeepingScroll();
    showToast(choice.model ? `已为${{ interview: "访谈", generation: "生成", evaluation: "评审" }[workflow]}切换模型。` : "已恢复使用默认模型。");
    return true;
  } catch (error) {
    state.modelSettings = previousSettings;
    renderWorkflowModelSelectors();
    if (workflow === "generation") renderWorkspaceKeepingScroll();
    showToast(error.message);
    return false;
  } finally {
    select.disabled = false;
  }
}

async function refreshModelSettings() {
  state.modelSettings = await request("/api/settings/model");
  byId("provider-select").value = state.modelSettings.provider;
  populateProviderFields(state.modelSettings.provider);
  renderModelChip();
  renderWorkflowModelSelectors();
}

async function openModelSettingsDialog(options = {}) {
  const dialog = byId("settings-dialog");
  if (!dialog.open) dialog.showModal();
  byId("settings-feedback").textContent = "正在读取当前模型设置…";
  byId("settings-feedback").style.color = "";
  try {
    await refreshModelSettings();
    byId("settings-feedback").textContent = "";
    byId("settings-feedback").style.color = "";
    if (options.focusApiKey && state.modelSettings.provider === "openai" && !state.modelSettings.providers.openai.api_key_configured) {
      byId("openai-api-key").focus();
    }
  } catch (error) {
    byId("settings-feedback").textContent = `读取模型设置失败：${error.message}`;
    byId("settings-feedback").style.color = "#a14a30";
  }
}

async function saveModelSettings(event) {
  event.preventDefault();
  if (!state.modelSettings) return;
  const provider = byId("provider-select").value;
  const config = provider === "openai"
    ? { model: byId("openai-model").value.trim(), base_url: byId("openai-base-url").value.trim(), api_key: byId("openai-api-key").value }
    : { model: byId("ollama-model").value.trim(), base_url: byId("ollama-base-url").value.trim() };
  const feedback = byId("settings-feedback");
  const button = byId("settings-form").querySelector("button[type=submit]");
  setBusy(button, true, "正在应用…");
  feedback.textContent = "";
  try {
    state.modelSettings = await request("/api/settings/model", {
      method: "PUT",
      body: JSON.stringify({ provider, [provider]: config })
    });
    populateProviderFields(provider);
    renderModelChip();
    renderWorkflowModelSelectors();
    feedback.style.color = "#70876b";
    if (provider === "ollama") {
      feedback.textContent = "Ollama 设置已保存。";
    } else if (state.modelSettings.providers.openai.api_key_configured) {
      feedback.textContent = "设置已保存。API Key 保存在此浏览器，留空会继续沿用。";
    } else {
      feedback.textContent = "设置已保存。请填写并应用 API Key 后再测试模型。";
    }
    if (provider === "openai") byId("openai-api-key").value = "";
  } catch (error) {
    feedback.textContent = error.message;
    feedback.style.color = "#a14a30";
  } finally {
    setBusy(button, false);
  }
}

function modelActionPayload(provider) {
  const prefix = provider === "openai" ? "openai" : "ollama";
  const payload = {
    provider,
    model: byId(`${prefix}-model`).value.trim() || null,
    base_url: byId(`${prefix}-base-url`).value.trim()
  };
  if (provider === "openai") payload.api_key = byId("openai-api-key").value;
  return payload;
}

function setSettingsFeedback(message, isError = false) {
  const feedback = byId("settings-feedback");
  feedback.textContent = message;
  feedback.style.color = isError ? "#a14a30" : "#70876b";
}

async function fetchProviderModels(provider) {
  const button = byId(provider === "openai" ? "fetch-openai-models" : "fetch-ollama-models");
  const toggle = byId(`${provider}-model-toggle`);
  if (button.disabled) return;
  setBusy(button, true, "正在获取…");
  toggle.disabled = true;
  setSettingsFeedback("正在连接服务并读取模型列表…");
  try {
    const result = await request("/api/models/list", {
      method: "POST",
      body: JSON.stringify(modelActionPayload(provider))
    });
    state.modelLists[provider] = result.models || [];
    renderModelOptions(provider, "", true);
    renderWorkflowModelSelectors();
    setSettingsFeedback(`已获取 ${state.modelLists[provider].length} 个模型，列表已展开；点击选择，或直接输入自定义名称。`);
  } catch (error) {
    setSettingsFeedback(error.message, true);
  } finally {
    setBusy(button, false);
    toggle.disabled = false;
  }
}

function renderModelOptions(provider, query = "", isOpen = true) {
  const input = byId(`${provider}-model`);
  const menu = byId(`${provider}-model-options`);
  const toggle = byId(`${provider}-model-toggle`);
  const searchText = String(query || "").trim().toLocaleLowerCase();
  const models = state.modelLists[provider] || [];
  const visibleModels = searchText
    ? models.filter((name) => name.toLocaleLowerCase().includes(searchText))
    : models;
  menu.replaceChildren();

  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "model-options-empty";
    empty.textContent = "点击“获取列表”读取可用模型，也可以手动输入名称。";
    menu.append(empty);
  } else if (!visibleModels.length) {
    const empty = document.createElement("div");
    empty.className = "model-options-empty";
    empty.textContent = "没有匹配的模型；仍可使用输入的自定义名称。";
    menu.append(empty);
  } else {
    for (const name of visibleModels) {
      const option = document.createElement("button");
      option.className = "model-option";
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(input.value === name));
      option.classList.toggle("is-selected", input.value === name);
      option.textContent = name;
      option.addEventListener("click", () => {
        input.value = name;
        closeModelMenu(provider);
        input.focus();
        setSettingsFeedback(`已选择模型：${name}`);
      });
      menu.append(option);
    }
  }

  menu.classList.toggle("is-hidden", !isOpen);
  menu.setAttribute("aria-hidden", String(!isOpen));
  input.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-label", isOpen ? "收起模型列表" : "展开模型列表");
  toggle.title = isOpen ? "收起模型列表" : "展开模型列表";
}

function closeModelMenu(provider) {
  const menu = byId(`${provider}-model-options`);
  menu.classList.add("is-hidden");
  menu.setAttribute("aria-hidden", "true");
  byId(`${provider}-model`).setAttribute("aria-expanded", "false");
  byId(`${provider}-model-toggle`).setAttribute("aria-expanded", "false");
  byId(`${provider}-model-toggle`).setAttribute("aria-label", "展开模型列表");
  byId(`${provider}-model-toggle`).title = "展开模型列表";
}

function invalidateModelOptions(provider) {
  state.modelLists[provider] = [];
  closeModelMenu(provider);
  renderWorkflowModelSelectors();
}

function closeAllModelMenus() {
  closeModelMenu("openai");
  closeModelMenu("ollama");
}

function toggleModelMenu(provider) {
  const menu = byId(`${provider}-model-options`);
  if (!menu.classList.contains("is-hidden")) {
    closeModelMenu(provider);
    return;
  }
  if (state.modelLists[provider]?.length) {
    renderModelOptions(provider, "", true);
    return;
  }
  if (byId(`fetch-${provider}-models`).disabled) return;
  fetchProviderModels(provider);
}

async function testModelConnection() {
  const provider = byId("provider-select").value;
  const button = byId("test-model-button");
  setBusy(button, true, "正在测试…");
  setSettingsFeedback("正在使用当前填写的设置调用模型…");
  try {
    const result = await request("/api/models/test", {
      method: "POST",
      body: JSON.stringify(modelActionPayload(provider))
    });
    setSettingsFeedback(result.message || "模型可以正常调用。");
  } catch (error) {
    setSettingsFeedback(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function clearSavedKey() {
  const feedback = byId("settings-feedback");
  try {
    const current = state.modelSettings.providers.openai;
    state.modelSettings = await request("/api/settings/model", {
      method: "PUT",
      body: JSON.stringify({ provider: byId("provider-select").value, openai: { model: current.model, base_url: current.base_url, clear_api_key: true } })
    });
    populateProviderFields("openai");
    renderModelChip();
    invalidateModelOptions("openai");
    feedback.style.color = "#70876b";
    feedback.textContent = "已清除此浏览器中保存的 API Key。";
  } catch (error) {
    feedback.style.color = "#a14a30";
    feedback.textContent = error.message;
  }
}

async function copyPrompt() {
  const version = getSelectedVersion();
  if (!version) return;
  try {
    await navigator.clipboard.writeText(version.prompt);
    showToast("提示词已复制到剪贴板。");
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = version.prompt;
    document.body.append(temporary);
    temporary.select();
    document.execCommand("copy");
    temporary.remove();
    showToast("提示词已复制到剪贴板。");
  }
  for (const buttonId of ["copy-button", "prompt-modal-copy-button"]) {
    const button = byId(buttonId);
    button.textContent = "已复制";
    button.classList.add("is-copied");
    window.setTimeout(() => { button.textContent = "复制"; button.classList.remove("is-copied"); }, 1600);
  }
}

function wireEvents() {
  byId("initial-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const content = byId("initial-request").value.trim();
    if (content) startSession(content);
  });
  byId("generate-button").addEventListener("click", () => {
    if (byId("generate-button").disabled) return;
    byId("generation-confirm-dialog").showModal();
  });
  byId("generation-confirm-close").addEventListener("click", () => byId("generation-confirm-dialog").close());
  byId("confirm-generation-button").addEventListener("click", () => {
    if (byId("confirm-generation-button").disabled) return;
    byId("generation-confirm-dialog").close();
    generatePrompt();
  });
  for (const button of document.querySelectorAll("[data-preview-filter]")) {
    button.addEventListener("click", () => {
      state.previewFilter = button.dataset.previewFilter;
      renderInterviewPreview();
      byId("interview-preview-list").scrollTop = 0;
      revealElement(byId("interview-preview-list"));
    });
  }
  byId("retry-button").addEventListener("click", retryCurrentAction);
  byId("copy-button").addEventListener("click", copyPrompt);
  byId("prompt-modal-copy-button").addEventListener("click", copyPrompt);
  const choosePromptView = (mode) => {
    state.promptView = mode;
    const version = getSelectedVersion();
    if (version) renderPromptView(version.prompt);
  };
  for (const buttonId of ["prompt-preview-button", "prompt-modal-preview-button"]) {
    byId(buttonId).addEventListener("click", () => choosePromptView("preview"));
  }
  for (const buttonId of ["prompt-source-button", "prompt-modal-source-button"]) {
    byId(buttonId).addEventListener("click", () => choosePromptView("source"));
  }
  const promptPreviewDialog = byId("prompt-preview-dialog");
  byId("expand-prompt-preview").addEventListener("click", () => {
    const version = getSelectedVersion();
    if (!version) return;
    renderVersionPanel(version);
    promptPreviewDialog.showModal();
    byId("prompt-preview-close").focus();
  });
  byId("prompt-preview-close").addEventListener("click", () => promptPreviewDialog.close());
  promptPreviewDialog.addEventListener("click", (event) => {
    if (event.target === promptPreviewDialog) promptPreviewDialog.close();
  });

  byId("score-collapse-button").addEventListener("click", () => {
    state.scoreCollapsed = !state.scoreCollapsed;
    updateScoreCollapse();
  });
  byId("version-history-toggle").addEventListener("click", () => {
    state.historyCollapsed = !state.historyCollapsed;
    updateHistoryCollapse();
  });

  const focusDialog = byId("focus-dialog");
  const focusContent = byId("focus-dialog-content");
  let focusedPanelInfo = null;
  const keepPanelScroll = (panel) => {
    const positions = [panel, ...panel.querySelectorAll(".conversation-scroll, .composer-dock, .answer-fields, .quick-replies-list, .prompt-text, #interview-preview-list")].map((node) => ({
      node,
      top: node.scrollTop,
      atEnd: node.scrollHeight > node.clientHeight && node.scrollHeight - node.clientHeight - node.scrollTop < 2,
    }));
    return () => window.requestAnimationFrame(() => {
      for (const { node, top, atEnd } of positions) node.scrollTop = atEnd ? node.scrollHeight : top;
    });
  };
  const restoreFocusedPanel = () => {
    if (!focusedPanelInfo) return;
    const { panel, placeholder, restoreScroll } = focusedPanelInfo;
    panel.classList.remove("is-focus-expanded");
    if (placeholder.parentNode) placeholder.parentNode.insertBefore(panel, placeholder);
    placeholder.remove();
    focusContent.replaceChildren();
    focusedPanelInfo = null;
    restoreScroll();
  };
  const openFocusedPanel = (panelId, title) => {
    if (focusedPanelInfo) return;
    const panel = byId(panelId);
    if (!panel || !panel.parentNode) {
      showToast("无法打开这个放大视图，请刷新页面后重试。");
      return;
    }
    const placeholder = document.createComment("原面板位置");
    const restoreScroll = keepPanelScroll(panel);
    panel.parentNode.insertBefore(placeholder, panel);
    focusedPanelInfo = { panel, placeholder, restoreScroll };
    panel.classList.add("is-focus-expanded");
    focusContent.append(panel);
    byId("focus-dialog-title").textContent = title;
    focusDialog.showModal();
    byId("focus-dialog-close").focus({ preventScroll: true });
    restoreScroll();
  };
  byId("conversation-zoom-button").addEventListener("click", () => openFocusedPanel("conversation-column", "需求对话"));
  byId("result-zoom-button").addEventListener("click", () => openFocusedPanel("result-column", "提示词结果与评分"));
  const rememberFocusedScroll = () => {
    if (focusedPanelInfo) focusedPanelInfo.restoreScroll = keepPanelScroll(focusedPanelInfo.panel);
  };
  const closeFocusedPanel = () => {
    // 弹窗关闭后其滚动区域已不可见，必须在关闭前记录阅读位置。
    rememberFocusedScroll();
    focusDialog.close();
  };
  byId("focus-dialog-close").addEventListener("click", closeFocusedPanel);
  focusDialog.addEventListener("cancel", rememberFocusedScroll);
  focusDialog.addEventListener("close", restoreFocusedPanel);
  focusDialog.addEventListener("click", (event) => {
    if (event.target === focusDialog) closeFocusedPanel();
  });

  const jumpNav = byId("question-jump-nav");
  const jumpRail = byId("question-jump-rail");
  const jumpList = byId("question-jump-menu-list");
  let jumpPinned = false;
  const setJumpMenuOpen = (open) => {
    jumpNav.classList.toggle("is-open", open);
    jumpRail.setAttribute("aria-expanded", String(open));
    byId("question-jump-menu").setAttribute("aria-hidden", String(!open));
  };
  jumpNav.addEventListener("mouseenter", () => setJumpMenuOpen(true));
  jumpNav.addEventListener("mouseleave", () => {
    if (!jumpPinned) setJumpMenuOpen(false);
  });
  jumpNav.addEventListener("focusin", () => setJumpMenuOpen(true));
  jumpNav.addEventListener("focusout", (event) => {
    if (!jumpPinned && !jumpNav.contains(event.relatedTarget)) setJumpMenuOpen(false);
  });
  jumpRail.addEventListener("click", () => {
    jumpPinned = !jumpPinned;
    setJumpMenuOpen(jumpPinned);
  });
  jumpList.addEventListener("click", (event) => {
    const item = event.target.closest(".question-jump-item");
    if (!item) return;
    jumpToQuestion(item.dataset.questionId);
    jumpPinned = false;
    setJumpMenuOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!jumpNav.contains(event.target)) {
      jumpPinned = false;
      setJumpMenuOpen(false);
    }
  });
  byId("conversation-scroll").addEventListener("scroll", updateQuestionJumpActive, { passive: true });

  byId("new-session-button").addEventListener("click", () => {
    state.session = null;
    state.selectedVersionId = null;
    state.selectedAnswerOptions = [];
    state.answerDraftQuestionId = null;
    state.answerDraftContent = "";
    state.feedbackDraftContent = "";
    state.feedbackCollapsed = false;
    state.activeQuestionId = null;
    state.pendingAnswerCheck = null;
    state.composerMode = null;
    hideRetry();
    byId("initial-form").reset();
    setWorkspaceVisible(false);
    renderSessionList();
    byId("initial-request").focus();
    byId("sidebar").classList.remove("is-open");
  });
  document.querySelectorAll(".example-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      byId("initial-request").value = chip.dataset.example || "";
      byId("initial-request").focus();
    });
  });

  byId("model-chip").addEventListener("click", openModelSettingsDialog);
  byId("open-model-settings-retry").addEventListener("click", openModelSettingsDialog);
  byId("settings-close").addEventListener("click", () => byId("settings-dialog").close());
  byId("provider-select").addEventListener("change", (event) => {
    closeAllModelMenus();
    populateProviderFields(event.target.value);
  });
  byId("interview-model-select").addEventListener("change", (event) => saveWorkflowModel("interview", event.target));
  byId("generation-model-select").addEventListener("change", (event) => saveWorkflowModel("generation", event.target));
  byId("evaluation-model-select").addEventListener("change", (event) => saveWorkflowModel("evaluation", event.target));
  for (const workflow of ["interview", "generation", "evaluation"]) {
    byId(`${workflow}-model-button`).addEventListener("click", () => openWorkflowPicker(workflow));
  }
  for (const view of ["interview", "prompt", "evaluation"]) byId(`${view}-tab`).addEventListener("click", () => setWorkspaceView(view));
  document.querySelector(".workspace-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const views = ["interview", "prompt", "evaluation"];
    const index = views.indexOf(state.workspaceView);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    setWorkspaceView(views[next]);
    byId(`${views[next]}-tab`).focus();
  });
  byId("include-generation-score").addEventListener("change", updateWorkspaceView);
  byId("return-interview-button").addEventListener("click", () => setWorkspaceView("interview"));
  byId("evaluate-button").addEventListener("click", () => {
    if (byId("evaluate-button").disabled) return;
    byId("evaluation-confirm-target").textContent = `评估 V${String(getSelectedVersion().revision).padStart(2, "0")} · 评分独立保存，提示词正文保持不变。`;
    byId("evaluation-confirm-dialog").showModal();
  });
  byId("evaluation-confirm-close").addEventListener("click", () => byId("evaluation-confirm-dialog").close());
  byId("confirm-evaluation-button").addEventListener("click", () => {
    if (byId("confirm-evaluation-button").disabled) return;
    byId("evaluation-confirm-dialog").close();
    evaluatePrompt();
  });
  byId("workflow-picker-close").addEventListener("click", () => byId("workflow-picker-dialog").close());
  byId("workflow-model-search").addEventListener("input", renderWorkflowPicker);
  byId("workflow-custom-apply").addEventListener("click", () => {
    const model = byId("workflow-custom-model").value.trim();
    if (!model) { byId("workflow-custom-model").focus(); showToast("请先填写模型名称。"); return; }
    chooseWorkflowModel(JSON.stringify([byId("workflow-custom-provider").value, model]));
  });
  byId("workflow-picker-settings").addEventListener("click", () => { byId("workflow-picker-dialog").close(); openModelSettingsDialog(); });
  byId("settings-form").addEventListener("submit", saveModelSettings);
  byId("fetch-openai-models").addEventListener("click", () => fetchProviderModels("openai"));
  byId("fetch-ollama-models").addEventListener("click", () => fetchProviderModels("ollama"));
  byId("test-model-button").addEventListener("click", testModelConnection);
  byId("clear-openai-key").addEventListener("click", clearSavedKey);
  for (const provider of ["openai", "ollama"]) {
    byId(`${provider}-model-toggle`).addEventListener("click", () => toggleModelMenu(provider));
    byId(`${provider}-base-url`).addEventListener("input", () => invalidateModelOptions(provider));
    byId(`${provider}-model`).addEventListener("input", (event) => {
      if (state.modelLists[provider]?.length) renderModelOptions(provider, event.target.value, true);
    });
    byId(`${provider}-model`).addEventListener("keydown", (event) => {
      const menu = byId(`${provider}-model-options`);
      if (event.key === "ArrowDown" && state.modelLists[provider]?.length) {
        event.preventDefault();
        if (menu.classList.contains("is-hidden")) renderModelOptions(provider, byId(`${provider}-model`).value, true);
        menu.querySelector(".model-option")?.focus();
      } else if (event.key === "Enter" && !menu.classList.contains("is-hidden")) {
        const firstOption = menu.querySelector(".model-option");
        if (firstOption) {
          event.preventDefault();
          firstOption.click();
        }
      }
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".model-input-wrap")) closeAllModelMenus();
  });
  byId("openai-api-key").addEventListener("input", (event) => {
    if (event.target.value) invalidateModelOptions("openai");
    const configured = Boolean(state.modelSettings?.providers.openai.api_key_configured);
    byId("openai-key-state").textContent = event.target.value
      ? configured ? "新密钥待保存" : "输入后保存"
      : configured ? "已保存，留空沿用" : "未配置";
  });
  byId("mobile-brand").addEventListener("click", () => byId("sidebar").classList.toggle("is-open"));
  let sidebarCollapsed = false;
  try {
    sidebarCollapsed = localStorage.getItem("prompt-room-sidebar-collapsed") === "true";
  } catch {
    sidebarCollapsed = false;
  }
  setSidebarCollapsed(sidebarCollapsed, false);
  byId("sidebar-toggle").addEventListener("click", () => {
    setSidebarCollapsed(!document.querySelector(".app-shell").classList.contains("is-sidebar-collapsed"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ["openai", "ollama"].some((provider) => !byId(`${provider}-model-options`).classList.contains("is-hidden"))) {
      closeAllModelMenus();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && jumpNav.classList.contains("is-open")) {
      event.preventDefault();
      jumpPinned = false;
      setJumpMenuOpen(false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (document.activeElement === byId("answer-input")) byId("answer-form")?.requestSubmit();
      if (document.activeElement === byId("feedback-input")) byId("feedback-form")?.requestSubmit();
      if (document.activeElement === byId("initial-request")) byId("initial-form").requestSubmit();
    }
  });
}

async function initialise() {
  wireEvents();
  try {
    await refreshModelSettings();
    await refreshSessions();
    if (state.sessions.length) {
      await loadSession(state.sessions[0].id);
    } else {
      setWorkspaceVisible(false);
    }
  } catch (error) {
    showToast(error.message);
  }
}

initialise();
