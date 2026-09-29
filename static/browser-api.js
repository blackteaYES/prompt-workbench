(() => {
  const DATABASE_NAME = "prompt-refiner-browser";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "workspace";
  const STATE_KEY = "main";
  const DIMENSION_NAMES = ["目标清晰度", "背景完整度", "约束覆盖度", "输出要求明确度"];
  const runtimeKeys = { openai: "" };
  let databasePromise;

  const makeError = (message, status = 502) => {
    const error = new Error(message);
    error.status = status;
    return error;
  };

  function defaultState() {
    return {
      sessions: [],
      settings: {
        provider: "openai",
        providers: {
          openai: { model: "gpt-4o-mini", base_url: "" },
          ollama: { model: "qwen2.5:7b", base_url: "http://127.0.0.1:11434" },
        },
      },
    };
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("浏览器不支持 IndexedDB"));
        return;
      }
      const opening = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE_NAME)) {
          opening.result.createObjectStore(STORE_NAME);
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error || new Error("无法打开本地数据"));
      opening.onblocked = () => reject(new Error("本地数据正在被其他页面占用，请关闭重复页面后重试。"));
    });
    return databasePromise;
  }

  function readLocalFallback() {
    try {
      const saved = window.localStorage.getItem("prompt-refiner-browser-state");
      return saved ? { ...defaultState(), ...JSON.parse(saved) } : defaultState();
    } catch {
      return defaultState();
    }
  }

  async function readState() {
    try {
      const database = await openDatabase();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
        request.onsuccess = () => resolve(request.result ? { ...defaultState(), ...request.result } : defaultState());
        request.onerror = () => reject(request.error || new Error("无法读取本地数据"));
      });
    } catch {
      return readLocalFallback();
    }
  }

  async function writeState(state) {
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("无法保存本地数据"));
        transaction.onabort = () => reject(transaction.error || new Error("保存本地数据已中断"));
      });
    } catch (indexedDbError) {
      try {
        window.localStorage.setItem("prompt-refiner-browser-state", JSON.stringify(state));
      } catch {
        throw makeError(`无法保存浏览器本地数据：${indexedDbError.message || "存储空间不可用"}`, 507);
      }
    }
  }

  function visibleSettings(state) {
    const providers = {};
    for (const provider of ["openai", "ollama"]) {
      const config = state.settings.providers[provider];
      providers[provider] = {
        model: config.model,
        base_url: config.base_url,
        api_key_configured: provider === "openai" && Boolean(runtimeKeys.openai),
      };
    }
    return { provider: state.settings.provider, providers };
  }

  function providerSettings(payload, state) {
    const provider = payload.provider === "ollama" ? "ollama" : "openai";
    const saved = state.settings.providers[provider];
    return {
      provider,
      model: String(payload.model || saved.model || "").trim(),
      baseUrl: String(payload.base_url || saved.base_url || "").trim(),
      apiKey: String(payload.api_key || runtimeKeys.openai || "").trim(),
    };
  }

  function endpointFor(baseUrl, suffix, fallback) {
    const base = (baseUrl || fallback).trim().replace(/\/+$/, "");
    return `${base}${suffix}`;
  }

  async function readResponse(response) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.detail;
      const message = typeof detail === "string" ? detail : "服务返回了无法识别的错误信息。";
      if (response.status === 401 || response.status === 403) {
        throw makeError("模型服务拒绝了 API Key。请检查密钥权限和 Base URL。", 502);
      }
      if (response.status === 404) {
        throw makeError("模型服务找不到接口或模型。请检查 Base URL（通常以 /v1 结尾）和模型名称。", 502);
      }
      throw makeError(`模型服务返回错误（${response.status}）：${message}`, 502);
    }
    return payload;
  }

  async function fetchProvider(url, options, provider, action) {
    try {
      const response = await fetch(url, options);
      return await readResponse(response);
    } catch (error) {
      if (error.status) throw error;
      const service = provider === "ollama" ? "Ollama" : "OpenAI 兼容服务";
      throw makeError(`无法连接${service}。请检查网络、地址和 CORS 跨域设置；直接打开本地 HTML 时，目标服务必须允许浏览器页面访问。${action === "list" ? "也可以手动填写模型名称。" : ""}`, 502);
    }
  }

  function modelErrorMessage(provider) {
    return provider === "ollama"
      ? "无法调用 Ollama。请确认服务已启动、模型已下载，并检查 Base URL 与 CORS 跨域设置。"
      : "模型请求失败。请检查网络、API Key、模型名称、Base URL 和 CORS 跨域设置。";
  }

  async function invokeModelJson(systemPrompt, userPrompt, state, options = {}) {
    const provider = state.settings.provider;
    const config = state.settings.providers[provider];
    const model = String(config.model || "").trim();
    const baseUrl = config.base_url || "";
    if (!model) throw makeError("请先在模型设置中填写模型名称。", 502);
    if (provider === "openai" && !runtimeKeys.openai) {
      throw makeError("尚未配置 API Key。请在模型设置中填写临时密钥；密钥只保留在当前浏览器页面内存中，刷新后需要重新填写。", 502);
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), options.timeout || 90000);
    try {
      let response;
      if (provider === "ollama") {
        response = await fetch(endpointFor(baseUrl, "/api/chat", "http://127.0.0.1:11434"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: false,
            format: "json",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            options: { temperature: 0.2, num_predict: options.outputTokens || 1800 },
          }),
        });
        const payload = await readResponse(response);
        return parseModelJson(payload?.message?.content || "");
      }

      response = await fetch(endpointFor(baseUrl, "/chat/completions", "https://api.openai.com/v1"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runtimeKeys.openai}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: options.outputTokens || 1800,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      const payload = await readResponse(response);
      return parseModelJson(payload?.choices?.[0]?.message?.content || "");
    } catch (error) {
      if (error.status) throw error;
      if (error.name === "AbortError") throw makeError("模型响应超时。会话内容已保存在本机，请检查模型服务后重试。", 502);
      if (error.message === "模型没有返回有效的 JSON 对象。") throw makeError("模型没有按要求返回结果，请重试；当前会话内容已保存在本机。", 502);
      if (error.message?.includes("无法连接")) throw error;
      throw makeError(modelErrorMessage(provider), 502);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function parseModelJson(rawText) {
    const text = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          // 模型返回内容并非 JSON 时，由下方统一提示重试。
        }
      }
    }
    throw new Error("模型没有返回有效的 JSON 对象。");
  }

  function sessionById(state, sessionId) {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) throw makeError("找不到这个会话。", 404);
    return session;
  }

  function appendMessage(session, role, kind, content, extra = {}) {
    const createdAt = new Date().toISOString();
    const id = session.messages.reduce((maximum, message) => Math.max(maximum, Number(message.id) || 0), 0) + 1;
    const previousQuestion = [...session.messages].reverse().find((message) => message.role === "assistant" && message.kind === "question");
    const message = { id, role, kind, content, created_at: createdAt, ...extra };
    if (role === "user" && kind === "answer" && previousQuestion) message.question_id = previousQuestion.id;
    session.messages.push(message);
    session.updated_at = createdAt;
    return message;
  }

  function listSessionSummary(session) {
    const newestVersion = session.versions[0] || null;
    return {
      id: session.id,
      title: session.title,
      updated_at: session.updated_at,
      version_count: session.versions.length,
      latest_score: newestVersion ? newestVersion.overall_score : null,
    };
  }

  function contextFor(session) {
    return session.messages.map(({ role, kind, content }) => ({ role, kind, content }));
  }

  function latestVersion(session) {
    return session.versions[0] || null;
  }

  function clampScore(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : fallback;
  }

  function composeAnswer(payload) {
    const customContent = String(payload.content || "").trim();
    const selectedOptions = [...new Set((payload.selected_options || []).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
    if (!customContent && !selectedOptions.length) throw makeError("请至少选择一项，或填写补充说明。", 422);
    const parts = [];
    if (selectedOptions.length) parts.push(`选择的选项：\n${selectedOptions.map((option) => `- ${option}`).join("\n")}`);
    if (customContent) parts.push(selectedOptions.length ? `补充说明：\n${customContent}` : customContent);
    return { content: parts.join("\n\n"), selectedOptions };
  }

  async function askQuestion(state, session, refinementMode = false) {
    const currentVersion = latestVersion(session);
    const systemPrompt = `你是一位提示词需求访谈员。你的工作是帮助用户把原始想法补充为清晰、可执行的提示词。
根据原始需求和已有对话，识别尚未回答、会显著影响提示词质量的细节。每轮至多提出一个具体问题，不重复已回答内容。可关注目标、受众、场景、输入材料、边界约束、输出格式和成功标准。
每个问题同时给出 2 到 4 个简短、可直接提交的建议回答，作为快捷选项；再从这些选项中挑出一个最符合原始需求和已知信息的推荐项，recommended_answer 必须与其中一个选项完全一致。选项应覆盖常见方向，不要代替开放式回答，也不要包含“其他”或“自定义”选项。建议回答和问题都使用用户原始需求的主要语言。
不要展示内部思考过程，不要直接生成最终提示词。用用户原始需求的主要语言提问。
如果没有必要继续追问，question 返回空字符串，并用 status_note 简短说明可以生成或等待用户补充；此时仍由用户手动决定是否生成。
只返回 JSON 对象，格式为：{"question":"一个问题或空字符串","suggested_answers":["建议回答一","建议回答二","建议回答三"],"recommended_answer":"从建议回答中原样选择一项","status_note":"简短说明"}${refinementMode ? "\n这是用户对已有版本提出反馈后的追问；先判断反馈是否需要补充关键信息，不要自动改写提示词。" : ""}`;
    const payload = {
      原始需求: session.original_request,
      已保存的问答与反馈: contextFor(session),
      上一版提示词: currentVersion?.prompt || null,
      上一版改进说明: currentVersion?.improvement_notes || null,
    };
    const result = await invokeModelJson(systemPrompt, JSON.stringify(payload), state);
    const question = typeof result.question === "string" ? result.question.trim() : "";
    const statusNote = typeof result.status_note === "string" ? result.status_note.trim() : "";
    if (result.question !== undefined && typeof result.question !== "string") throw makeError("模型返回的追问格式不正确，请重试；当前会话内容已保留。", 502);
    if (result.status_note !== undefined && typeof result.status_note !== "string") throw makeError("模型返回的追问格式不正确，请重试；当前会话内容已保留。", 502);
    if (question) {
      const suggestions = [...new Set((Array.isArray(result.suggested_answers) ? result.suggested_answers : []).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 5);
      const recommended = typeof result.recommended_answer === "string" && suggestions.includes(result.recommended_answer.trim())
        ? result.recommended_answer.trim()
        : null;
      appendMessage(session, "assistant", "question", question, {
        suggested_answers: suggestions,
        ...(recommended ? { recommended_answer: recommended } : {}),
      });
    } else {
      appendMessage(session, "assistant", "notice", statusNote || (refinementMode
        ? "可以点击“生成并评分”，查看下一版提示词。"
        : "你可以继续补充，也可以点击“生成并评分”。"));
    }
    session.updated_at = new Date().toISOString();
    return { question: question || null, status_note: statusNote || null };
  }

  async function recommendOption(state, session) {
    const question = session.messages[session.messages.length - 1];
    const choices = question?.suggested_answers || [];
    if (question?.kind !== "question" || !choices.length) return { recommended_answer: null };
    if (choices.includes(question.recommended_answer)) return { recommended_answer: question.recommended_answer };
    const systemPrompt = "你是提示词需求访谈助手。请结合用户的原始需求和已有回答，从给定的候选选项中推荐最合适的一项。只返回 JSON 对象，格式为：{\"recommended_answer\":\"候选选项中的完整原文\"}。推荐内容必须与候选选项之一完全一致，不要改写，也不要解释。";
    const payload = {
      原始需求: session.original_request,
      已有问答与反馈: contextFor(session),
      当前问题: question.content,
      候选选项: choices,
    };
    const result = await invokeModelJson(systemPrompt, JSON.stringify(payload), state, { outputTokens: 100 });
    const recommendation = typeof result.recommended_answer === "string" ? result.recommended_answer.trim() : "";
    if (!choices.includes(recommendation)) throw makeError("模型暂时没有选出有效的推荐项；你仍可照常选择或补充回答。", 502);
    question.recommended_answer = recommendation;
    await writeState(state);
    return { recommended_answer: recommendation };
  }

  async function generateVersion(state, session) {
    const currentVersion = latestVersion(session);
    const systemPrompt = `你是提示词编辑与评估助手。请根据原始需求、用户回答和反馈，写出可直接复制使用的完整提示词，并进行诚实、克制的质量评分。
提示词应保留用户原意，将已经提供的上下文、约束、目标和输出要求写清楚；不要虚构用户没有提供的事实。信息不足时把必要细节转化为提示词中的待补充占位符。
输出提示词时使用用户原始需求的主要语言。评分和改进说明使用中文。
总分范围 0 到 100。维度必须严格包含：目标清晰度、背景完整度、约束覆盖度、输出要求明确度；每项给 0 到 100 分及一句依据。改进说明简述本版做了哪些完善以及仍可补充什么。
只返回 JSON 对象，格式为：{"prompt":"完整提示词","overall_score":80,"dimensions":[{"name":"目标清晰度","score":80,"note":"评分依据"},{"name":"背景完整度","score":70,"note":"评分依据"},{"name":"约束覆盖度","score":75,"note":"评分依据"},{"name":"输出要求明确度","score":70,"note":"评分依据"}],"improvement_notes":"完善说明和仍可补充的内容"}
不要返回 Markdown 围栏或 JSON 以外的说明。`;
    const payload = {
      原始需求: session.original_request,
      完整对话与反馈: contextFor(session),
      上一版提示词: currentVersion?.prompt || null,
      上一版评分与完善说明: currentVersion ? {
        overall_score: currentVersion.overall_score,
        dimensions: currentVersion.dimensions,
        improvement_notes: currentVersion.improvement_notes,
      } : null,
    };
    const result = await invokeModelJson(systemPrompt, JSON.stringify(payload), state);
    const prompt = typeof result.prompt === "string" ? result.prompt.trim() : "";
    if (!prompt) throw makeError("模型没有返回提示词，请点击重试；当前会话内容已保留。", 502);
    const overallScore = clampScore(result.overall_score, 0);
    const rawDimensions = Array.isArray(result.dimensions)
      ? result.dimensions
      : Object.entries(result.dimensions || {}).map(([name, value]) => ({ name, ...value }));
    const dimensionMap = new Map(rawDimensions.filter((item) => item && typeof item.name === "string").map((item) => [item.name.trim(), item]));
    const dimensions = DIMENSION_NAMES.map((name) => {
      const item = dimensionMap.get(name) || {};
      return {
        name,
        score: clampScore(item.score, overallScore),
        note: String(item.note || "模型未提供单独说明。").slice(0, 500),
      };
    });
    let notes = result.improvement_notes ?? "";
    if (Array.isArray(notes)) notes = notes.map((item) => `• ${String(item)}`).join("\n");
    const version = {
      id: session.versions.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0) + 1,
      revision: session.versions.reduce((maximum, item) => Math.max(maximum, Number(item.revision) || 0), 0) + 1,
      prompt,
      overall_score: overallScore,
      dimensions,
      improvement_notes: String(notes),
      created_at: new Date().toISOString(),
      source_message_id: session.messages.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0),
    };
    session.versions.unshift(version);
    session.updated_at = version.created_at;
    await writeState(state);
    return version;
  }

  async function listModels(payload, state) {
    const settings = providerSettings(payload, state);
    const url = settings.provider === "ollama"
      ? endpointFor(settings.baseUrl, "/api/tags", "http://127.0.0.1:11434")
      : endpointFor(settings.baseUrl, "/models", "https://api.openai.com/v1");
    const headers = { Accept: "application/json" };
    if (settings.provider === "openai" && settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const data = await fetchProvider(url, { method: "GET", headers }, settings.provider, "list");
    const rawModels = settings.provider === "ollama" ? data.models : data.data;
    const models = [...new Set((Array.isArray(rawModels) ? rawModels : []).map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") return String(item.id || item.name || item.model || "").trim();
      return "";
    }).filter(Boolean))];
    if (!models.length) throw makeError("接口已响应，但没有返回可用模型列表。你仍可手动输入模型名称。", 502);
    return { models };
  }

  async function testModel(payload, state) {
    const settings = providerSettings(payload, state);
    if (!settings.model) throw makeError("请先选择或输入模型名称，再测试模型连接。", 422);
    const temporaryState = {
      ...state,
      settings: {
        ...state.settings,
        provider: settings.provider,
        providers: {
          ...state.settings.providers,
          [settings.provider]: { model: settings.model, base_url: settings.baseUrl },
        },
      },
    };
    const previousKey = runtimeKeys.openai;
    if (settings.provider === "openai") runtimeKeys.openai = settings.apiKey;
    try {
      await invokeModelJson(
        "你正在执行连接测试。只返回 JSON 对象：{\"status\":\"ok\"}",
        "请确认连接并返回指定 JSON。",
        temporaryState,
        { timeout: 30000, outputTokens: 32 },
      );
    } finally {
      runtimeKeys.openai = previousKey;
    }
    return { message: `模型「${settings.model}」可以正常调用。` };
  }

  async function dispatch(path, options) {
    const method = (options.method || "GET").toUpperCase();
    let payload = {};
    if (options.body) {
      try { payload = JSON.parse(options.body); }
      catch { throw makeError("请求内容格式不正确。", 400); }
    }
    const state = await readState();

    if (path === "/api/health" && method === "GET") return { ok: true };
    if (path === "/api/settings/model" && method === "GET") return visibleSettings(state);
    if (path === "/api/settings/model" && method === "PUT") {
      const provider = payload.provider === "ollama" ? "ollama" : "openai";
      state.settings.provider = provider;
      for (const name of ["openai", "ollama"]) {
        const incoming = payload[name];
        if (!incoming) continue;
        const current = state.settings.providers[name];
        if (incoming.model && String(incoming.model).trim()) current.model = String(incoming.model).trim();
        if (incoming.base_url !== undefined) current.base_url = String(incoming.base_url || "").trim();
        if (name === "openai") {
          if (incoming.clear_api_key) runtimeKeys.openai = "";
          else if (incoming.api_key && String(incoming.api_key).trim()) runtimeKeys.openai = String(incoming.api_key).trim();
        }
      }
      await writeState(state);
      return visibleSettings(state);
    }
    if (path === "/api/models/list" && method === "POST") return listModels(payload, state);
    if (path === "/api/models/test" && method === "POST") return testModel(payload, state);

    if (path === "/api/sessions" && method === "GET") {
      return { sessions: [...state.sessions].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).map(listSessionSummary) };
    }
    if (path === "/api/sessions" && method === "POST") {
      const originalRequest = String(payload.initial_request || "").trim();
      if (!originalRequest) throw makeError("请先输入你想完善的需求。", 422);
      if (originalRequest.length > 20000) throw makeError("初始需求超过字数限制。", 422);
      const titleText = originalRequest.replace(/\s+/g, " ");
      const title = [...titleText].slice(0, 52).join("") + ([...titleText].length > 52 ? "…" : "");
      const createdAt = new Date().toISOString();
      const session = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title,
        original_request: originalRequest,
        created_at: createdAt,
        updated_at: createdAt,
        messages: [],
        versions: [],
      };
      appendMessage(session, "user", "initial", originalRequest);
      state.sessions.push(session);
      await writeState(state);
      return session;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!sessionMatch) throw makeError("找不到这个浏览器端功能。", 404);
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2] || "";
    const session = sessionById(state, sessionId);

    if (!action && method === "GET") return session;
    if (!action && method === "DELETE") {
      state.sessions = state.sessions.filter((item) => item.id !== sessionId);
      await writeState(state);
      return { deleted: true };
    }
    if (action === "ask-next" && method === "POST") {
      try {
        const result = await askQuestion(state, session, Boolean(payload.refinement_mode));
        await writeState(state);
        return result;
      } catch (error) {
        await writeState(state);
        throw error;
      }
    }
    if (action === "recommendation" && method === "POST") return recommendOption(state, session);
    if (action === "turn" && method === "POST") {
      const answer = composeAnswer(payload);
      appendMessage(session, "user", "answer", answer.content, { selected_options: answer.selectedOptions });
      await writeState(state);
      try {
        const result = await askQuestion(state, session, false);
        await writeState(state);
        return result;
      } catch (error) {
        await writeState(state);
        throw error;
      }
    }
    const editMatch = action.match(/^messages\/(\d+)$/);
    if (editMatch && method === "PUT") {
      const message = session.messages.find((item) => item.id === Number(editMatch[1]) && item.role === "user" && item.kind === "answer");
      if (!message) throw makeError("找不到这条可修改的回答。", 404);
      const answer = composeAnswer(payload);
      message.content = answer.content;
      message.selected_options = answer.selectedOptions;
      message.edited_at = new Date().toISOString();
      session.updated_at = message.edited_at;
      await writeState(state);
      return session;
    }
    if (action === "refine" && method === "POST") {
      if (!session.versions.length) throw makeError("请先生成第一版提示词，再提交完善意见。", 409);
      const content = String(payload.content || "").trim();
      if (!content) throw makeError("请先写下希望调整的地方。", 422);
      appendMessage(session, "user", "feedback", content);
      await writeState(state);
      try {
        const result = await askQuestion(state, session, true);
        await writeState(state);
        return result;
      } catch (error) {
        await writeState(state);
        throw error;
      }
    }
    if (action === "generate" && method === "POST") {
      const version = await generateVersion(state, session);
      return { version };
    }
    throw makeError("找不到这个浏览器端功能。", 404);
  }

  window.browserApiRequest = async (path, options = {}) => dispatch(path, options);
})();
