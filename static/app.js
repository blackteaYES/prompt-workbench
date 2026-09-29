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
  modelSettings: null,
  retryMode: null,
  pendingAnswerCheck: null,
  recommendationPendingQuestionId: null,
  recommendationFailedQuestionId: null,
  suppressAutoRetry: false,
  toastTimer: null
};

const byId = (id) => document.getElementById(id);
const QUESTION_JUMP_TICK_LIMIT = 12;

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
  byId("open-model-settings-retry").classList.toggle("is-hidden", !needsModelSettings);
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
    form.append(optionsBlock);
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
  input.addEventListener("input", () => { state.answerDraftContent = input.value; });
  form.append(label, input);

  const thinkingNote = document.createElement("div");
  thinkingNote.className = "answer-thinking-note is-hidden";
  thinkingNote.setAttribute("role", "status");
  thinkingNote.setAttribute("aria-live", "polite");
  const thinkingSpinner = document.createElement("span");
  thinkingSpinner.className = "thinking-spinner";
  thinkingSpinner.setAttribute("aria-hidden", "true");
  const thinkingText = document.createElement("span");
  thinkingText.textContent = "已收到本轮回答，正在整理需求并准备下一问…";
  thinkingNote.append(thinkingSpinner, thinkingText);
  form.append(thinkingNote);

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
  const timestamp = document.createElement("span");
  timestamp.textContent = displayDateTime(message.created_at);
  meta.append(name, timestamp);
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
      const wasEditedAfterVersion = message.edited_at && Date.parse(message.edited_at) >= latestVersionTime;
      return isNewMessage || wasEditedAfterVersion;
    })
    : [];
  const answerCount = session.messages.filter((message) => message.role === "user" && message.kind === "answer").length;
  const canGenerate = hasVersions ? newUserInputs.length > 0 : answerCount > 0;
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
  messageList.replaceChildren(...session.messages.map((message) => {
    const isCurrentMessage = message.id === lastMessage?.id;
    return makeMessage(message, {
      isActiveQuestion: isActiveQuestion && isCurrentMessage,
      isFeedbackMode: feedbackMode && isCurrentMessage,
    });
  }));
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
  generateButton.classList.toggle("is-hidden", !canGenerate);
  generateButton.disabled = !canGenerate;
  if (canGenerate && hasVersions) {
    byId("generate-heading").textContent = "V" + String(latestVersion.revision).padStart(2, "0") + " 后有 " + newUserInputs.length + " 条信息更新";
    byId("generate-caption").textContent = "可现在按这些新回答或意见生成下一版，也可以继续回答当前问题。";
  } else if (canGenerate) {
    byId("generate-heading").textContent = "已提交 " + answerCount + " 条回答，可以生成第一版";
    byId("generate-caption").textContent = "点击后才会生成提示词和评分；也可以继续访谈再生成。";
  } else if (hasVersions && waitingForModel) {
    byId("generate-heading").textContent = "等本轮追问完成后再继续";
    byId("generate-caption").textContent = "如果模型没有响应，请先重试；新回答或意见保存后可生成下一版。";
  } else if (hasVersions) {
    byId("generate-heading").textContent = "还没有新的回答或意见";
    byId("generate-caption").textContent = "回答当前问题，或提交版本意见；新内容保存后才可生成下一版。";
  } else {
    byId("generate-heading").textContent = "先回答第一个问题";
    byId("generate-caption").textContent = "提交一条回答后，这里才会开放第一版生成。";
  }
  byId("generate-button-label").textContent = hasVersions ? "生成下一版并评分" : "生成第一版并评分";
  byId("version-count").textContent = hasVersions ? String(versions.length).padStart(2, "0") + " 个版本" : "尚未生成";
  byId("result-zoom-button").classList.toggle("is-hidden", !hasVersions);
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
}
function updateScoreCollapse() {
  const collapsed = state.scoreCollapsed;
  byId("score-card").classList.toggle("is-collapsed", collapsed);
  byId("score-card-body").hidden = collapsed;
  byId("score-collapse-button").textContent = collapsed ? "展开" : "收起";
  byId("score-collapse-button").setAttribute("aria-expanded", String(!collapsed));
  byId("score-collapsed-summary").textContent = `${byId("overall-score").textContent}/100`;
  byId("score-collapsed-summary").classList.toggle("is-hidden", !collapsed);
}

function updateHistoryCollapse() {
  const collapsed = state.historyCollapsed;
  byId("version-history").classList.toggle("is-collapsed", collapsed);
  byId("version-history-body").hidden = collapsed;
  byId("version-history-toggle").textContent = collapsed ? "展开" : "收起";
  byId("version-history-toggle").setAttribute("aria-expanded", String(!collapsed));
  const count = state.session?.versions?.length || 0;
  byId("version-history-summary").textContent = collapsed ? `${count} 个版本` : "";
  byId("version-history-summary").classList.toggle("is-hidden", !collapsed);
}

function renderVersionPanel(version) {
  if (!version) return;
  byId("overall-score").textContent = String(version.overall_score);
  byId("score-stamp").textContent = `V${String(version.revision).padStart(2, "0")}`;
  byId("prompt-version-number").textContent = String(version.revision).padStart(2, "0");
  byId("prompt-created-at").textContent = displayDateTime(version.created_at);
  byId("prompt-preview-version").textContent = `V${String(version.revision).padStart(2, "0")}`;
  byId("prompt-preview-footer-version").textContent = String(version.revision).padStart(2, "0");
  renderPromptView(version.prompt);
  updateScoreCollapse();
  updateHistoryCollapse();
  byId("improvement-notes").textContent = version.improvement_notes || "本次完善已整理为可直接使用的提示词。";

  const dimensions = byId("dimension-list");
  dimensions.replaceChildren();
  const dimensionItems = version.dimensions || [];
  for (const item of version.dimensions || []) {
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
    dimensions.append(row);
  }

  const radar = byId("score-radar");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const center = { x: 160, y: 118 };
  const radius = 68;
  const axes = [
    { name: "目标清晰度", label: "目标", angle: -90 },
    { name: "背景完整度", label: "背景", angle: 0 },
    { name: "约束覆盖度", label: "约束", angle: 90 },
    { name: "输出要求明确度", label: "输出", angle: 180 },
  ];
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
  title.textContent = "提示词四项评分雷达图";
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
  addSvgElement("text", { x: center.x, y: 26, class: "score-radar-label", "text-anchor": "middle" }, "目标");
  addSvgElement("text", { x: 246, y: center.y + 3, class: "score-radar-label", "text-anchor": "start" }, "背景");
  addSvgElement("text", { x: center.x, y: 218, class: "score-radar-label", "text-anchor": "middle" }, "约束");
  addSvgElement("text", { x: 74, y: center.y + 3, class: "score-radar-label", "text-anchor": "end" }, "输出");

  const versionList = byId("version-list");
  versionList.replaceChildren();
  for (const item of state.session.versions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `version-pill${item.id === version.id ? " is-selected" : ""}`;
    const number = document.createElement("b");
    number.textContent = `V${String(item.revision).padStart(2, "0")}`;
    const scoreLabel = document.createElement("span");
    scoreLabel.textContent = `${item.overall_score} 分`;
    button.title = `第 ${item.revision} 版 · 模型评分 ${item.overall_score} 分。点击查看该版提示词和评分。`;
    button.setAttribute("aria-label", `查看第 ${item.revision} 版，评分 ${item.overall_score} 分`);
    button.append(number, scoreLabel);
    button.addEventListener("click", () => {
      state.selectedVersionId = item.id;
      renderVersionPanel(item);
    });
    versionList.append(button);
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
  if (!state.session) return;
  byId("session-state-label").textContent = mode === "initial" ? "正在准备提问" : "正在整理回答";
  try {
    await request(`/api/sessions/${state.session.id}/ask-next`, {
      method: "POST",
      body: JSON.stringify({ refinement_mode: mode === "refinement" })
    });
    hideRetry();
    await loadSession(state.session.id);
    await refreshSessions();
  } catch (error) {
    showRetry(error.message, mode === "refinement" ? "refinement" : "answer");
  }
}

async function submitAnswer(event) {
  event.preventDefault();
  if (!state.session) return;
  const form = event.currentTarget;
  const input = byId("answer-input");
  const content = input.value.trim();
  const selectedOptions = [...state.selectedAnswerOptions];
  if (!content && !selectedOptions.length) {
    showToast("请选择一个或多个方向，或填写补充说明。");
    input.focus();
    return;
  }

  const button = form.querySelector("button[type=submit]");
  const previousMessageIds = new Set(state.session.messages.map((message) => String(message.id)));
  const expectedContent = answerMessageContent(content, selectedOptions);
  byId("session-state-label").textContent = "正在理解你的回答";
  setComposerThinking(form, true);
  setBusy(button, true, "正在理解…");
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
      showRetry("回答已保存，但模型没有完成下一轮提问。请检查模型连接，再点“重试访谈”；回答不会重复提交。", "answer");
    } else if (error.status === null || error.status >= 500) {
      state.pendingAnswerCheck = { expectedContent, previousMessageIds: [...previousMessageIds] };
      await checkAnswerSubmission();
    } else {
      byId("session-state-label").textContent = "等你回答";
      showToast(`回答没有提交：${error.message} 输入内容仍保留，请修正后重新提交。`);
    }
  } finally {
    setBusy(button, false);
    setComposerThinking(form, false);
  }
}

function setComposerThinking(form, isThinking) {
  form.classList.toggle("is-thinking", isThinking);
  form.setAttribute("aria-busy", String(isThinking));
  form.querySelector(".answer-thinking-note")?.classList.toggle("is-hidden", !isThinking);
  form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = isThinking; });
  byId("session-state").classList.toggle("is-thinking", isThinking);
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
  if (!state.session) return;
  const form = event.currentTarget;
  const input = byId("feedback-input");
  const content = input.value.trim();
  if (!content) {
    input.focus();
    return;
  }
  const button = form.querySelector("button[type=submit]");
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
    setBusy(button, false);
  }
}
async function generatePrompt() {
  if (!state.session) return;
  const button = byId("generate-button");
  setBusy(button, true, "正在生成并评分…");
  hideRetry();
  try {
    const result = await request(`/api/sessions/${state.session.id}/generate`, { method: "POST" });
    state.selectedVersionId = result.version.id;
    await loadSession(state.session.id);
    await refreshSessions();
    showToast(`版本 ${String(result.version.revision).padStart(2, "0")} 已保存。`);
  } catch (error) {
    if (error.status === 502) showRetry(error.message, "generate");
    else showToast(error.message);
  } finally {
    setBusy(button, false);
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
    byId("openai-key-state").textContent = config.api_key_configured ? "已有可用密钥" : "未配置";
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

async function refreshModelSettings() {
  state.modelSettings = await request("/api/settings/model");
  byId("provider-select").value = state.modelSettings.provider;
  populateProviderFields(state.modelSettings.provider);
  renderModelChip();
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
    feedback.textContent = "设置已应用于当前浏览器。API Key 只保留在此页面内存中。";
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
  const modelList = byId(`${provider}-model-list`);
  setBusy(button, true, "正在获取…");
  setSettingsFeedback("正在连接服务并读取模型列表…");
  try {
    const result = await request("/api/models/list", {
      method: "POST",
      body: JSON.stringify(modelActionPayload(provider))
    });
    modelList.replaceChildren(...(result.models || []).map((name) => {
      const option = document.createElement("option");
      option.value = name;
      return option;
    }));
    setSettingsFeedback(`已获取 ${modelList.options.length} 个模型。点击模型名称输入框选择，或直接输入自定义名称。`);
    byId(`${provider}-model`).focus();
  } catch (error) {
    setSettingsFeedback(error.message, true);
  } finally {
    setBusy(button, false);
  }
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

async function clearTemporaryKey() {
  const feedback = byId("settings-feedback");
  try {
    const current = state.modelSettings.providers.openai;
    state.modelSettings = await request("/api/settings/model", {
      method: "PUT",
      body: JSON.stringify({ provider: byId("provider-select").value, openai: { model: current.model, base_url: current.base_url, clear_api_key: true } })
    });
    populateProviderFields("openai");
    renderModelChip();
    feedback.style.color = "#70876b";
    feedback.textContent = "当前页面内存中的临时密钥已清除。";
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
    window.setTimeout(() => { button.textContent = "复制"; }, 1600);
  }
}

function wireEvents() {
  byId("initial-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const content = byId("initial-request").value.trim();
    if (content) startSession(content);
  });
  byId("generate-button").addEventListener("click", generatePrompt);
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
  const restoreFocusedPanel = () => {
    if (!focusedPanelInfo) return;
    const { panel, placeholder } = focusedPanelInfo;
    panel.classList.remove("is-focus-expanded");
    if (placeholder.parentNode) placeholder.parentNode.insertBefore(panel, placeholder);
    placeholder.remove();
    focusContent.replaceChildren();
    focusedPanelInfo = null;
  };
  const openFocusedPanel = (panelId, title) => {
    if (focusedPanelInfo) return;
    const panel = byId(panelId);
    if (!panel || !panel.parentNode) {
      showToast("无法打开这个放大视图，请刷新页面后重试。");
      return;
    }
    const placeholder = document.createComment("原面板位置");
    panel.parentNode.insertBefore(placeholder, panel);
    focusedPanelInfo = { panel, placeholder };
    panel.classList.add("is-focus-expanded");
    focusContent.append(panel);
    byId("focus-dialog-title").textContent = title;
    focusDialog.showModal();
    byId("focus-dialog-close").focus();
  };
  byId("conversation-zoom-button").addEventListener("click", () => openFocusedPanel("conversation-column", "需求对话"));
  byId("result-zoom-button").addEventListener("click", () => openFocusedPanel("result-column", "提示词结果与评分"));
  byId("focus-dialog-close").addEventListener("click", () => focusDialog.close());
  focusDialog.addEventListener("close", restoreFocusedPanel);
  focusDialog.addEventListener("click", (event) => {
    if (event.target === focusDialog) focusDialog.close();
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
  byId("settings-cancel").addEventListener("click", () => byId("settings-dialog").close());
  byId("provider-select").addEventListener("change", (event) => populateProviderFields(event.target.value));
  byId("settings-form").addEventListener("submit", saveModelSettings);
  byId("fetch-openai-models").addEventListener("click", () => fetchProviderModels("openai"));
  byId("fetch-ollama-models").addEventListener("click", () => fetchProviderModels("ollama"));
  byId("test-model-button").addEventListener("click", testModelConnection);
  byId("clear-openai-key").addEventListener("click", clearTemporaryKey);
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
