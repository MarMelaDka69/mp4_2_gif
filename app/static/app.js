(() => {
  "use strict";
  const STORAGE_KEY = "frameflow-jobs-v1";
  const MAX_SIZE = 50 * 1024 * 1024;
  const input = document.querySelector("#fileInput");
  const zone = document.querySelector("#dropzone");
  const list = document.querySelector("#jobsList");
  const count = document.querySelector("#jobCount");
  const clear = document.querySelector("#clearHistory");
  const toast = document.querySelector("#toast");
  let jobs = [];
  let toastTimer;
  const statuses = {
    PENDING: ["В очереди", "running"], RECEIVED: ["В очереди", "running"],
    STARTED: ["Конвертируется", "running"], RETRY: ["Повторная попытка", "running"],
    SUCCESS: ["Готово", "success"], FAILURE: ["Ошибка", "failure"],
    REVOKED: ["Отменено", "failure"], UPLOADING: ["Загрузка...", "running"],
  };
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const notice = (text) => {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
  };
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, 40).filter(j => !j.temporary))); }
    catch { /* Storage can be disabled in private mode. */ }
  };
  const load = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(stored)) jobs = stored.filter(j => typeof j.id === "string" && typeof j.name === "string").slice(0, 40);
    } catch { jobs = []; }
  };
  function render() {
    list.replaceChildren();
    count.textContent = String(jobs.length);
    clear.hidden = jobs.length === 0;
    if (!jobs.length) {
      const empty = el("div", "empty");
      empty.append(el("div", "empty-icon", "✧"), el("strong", "", "Пока здесь пусто"), el("p", "", "Добавь видео выше — и следи за конвертацией в реальном времени."));
      list.append(empty); return;
    }
    for (const job of jobs) {
      const [caption, stateClass] = statuses[job.status] || [job.status || "Неизвестно", ""];
      const card = el("article", "job");
      const top = el("div", "job-top");
      const file = el("div", "job-file");
      const details = el("div", ""); details.style.minWidth = "0";
      details.append(el("div", "filename", job.name), el("div", "file-sub", job.size ? `${(job.size / 1048576).toFixed(2)} МБ · MP4` : "MP4 → GIF"));
      file.append(el("div", "file-icon", "▣"), details);
      top.append(file, el("div", `job-status ${stateClass}`, caption));
      card.append(top);
      if (["PENDING", "RECEIVED", "STARTED", "UPLOADING", "RETRY"].includes(job.status)) {
        const bar = el("div", "progress-track"); bar.append(el("div", "progress-fill")); card.append(bar);
      }
      const bottom = el("div", "job-bottom");
      const info = el("span", "job-info", job.error ? `Ошибка: ${job.error}` : job.status === "SUCCESS" ? "Конвертация завершена — GIF доступен" : job.status === "UPLOADING" ? "Передаём файл на сервер..." : `ID: ${job.id}`);
      bottom.append(info);
      if (job.status === "SUCCESS") {
        const actions = el("div", "job-actions");
        const link = el("a", "download-btn", "↓ Скачать GIF");
        link.href = `/jobs/${encodeURIComponent(job.id)}/download`;
        const previewButton = el("button", "preview-btn", "Посмотреть");
        previewButton.type = "button";
        previewButton.addEventListener("click", () => {
          const existing = card.querySelector(".preview");
          if (existing) { existing.remove(); previewButton.textContent = "Посмотреть"; return; }
          const holder = el("div", "preview");
          const img = document.createElement("img"); img.alt = `GIF из ${job.name}`;
          img.src = `/jobs/${encodeURIComponent(job.id)}/download`;
          holder.append(img); card.append(holder); previewButton.textContent = "Скрыть";
        });
        actions.append(previewButton, link); bottom.append(actions);
      }
      card.append(bottom); list.append(card);
    }
  }
  async function upload(file) {
    const name = file.name || "video.mp4";
    if (!name.toLowerCase().endsWith(".mp4")) { notice(`${name}: поддерживаются только MP4`); return; }
    if (file.size > MAX_SIZE) { notice(`${name}: файл больше 50 МБ`); return; }
    if (file.size === 0) { notice(`${name}: пустой файл`); return; }
    const tempId = `temp-${Math.random().toString(36).slice(2)}`;
    const job = {id: tempId, name, size: file.size, status: "UPLOADING", temporary: true};
    jobs.unshift(job); render();
    try {
      const form = new FormData(); form.append("file", file);
      const resp = await fetch("/jobs", {method: "POST", body: form});
      const data = await resp.json();
      if (!resp.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${resp.status}`);
      job.id = data.task_id; job.status = "PENDING"; job.temporary = false;
      save(); render(); refresh(job);
    } catch (error) {
      job.status = "FAILURE"; job.error = error.message || "Не удалось загрузить файл";
      job.temporary = false; save(); render();
      notice(`Не получилось загрузить ${name}`);
    }
  }
  function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    files.forEach(upload);
    location.hash = "jobs";
  }
  async function refresh(job) {
    if (job.temporary || ["FAILURE", "SUCCESS", "REVOKED"].includes(job.status)) return;
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(job.id)}`, {cache: "no-store"});
      if (response.status === 404) {
        job.status = "FAILURE"; job.error = "Задача не найдена (результат мог устареть)";
      } else if (response.ok) {
        const data = await response.json();
        job.status = data.status;
        if (data.error) job.error = data.error;
      } else { return; }
      save(); render();
    } catch { /* Temporary network outage; try again on next poll. */ }
  }
  zone.addEventListener("click", (ev) => { if (ev.target.closest("#chooseBtn")) return; input.click(); });
  document.querySelector("#chooseBtn").addEventListener("click", (ev) => {ev.stopPropagation(); input.click();});
  zone.addEventListener("keydown", (ev) => {if (ev.target === zone && (ev.key === "Enter" || ev.key === " ")) {ev.preventDefault(); input.click();}});
  input.addEventListener("change", () => {addFiles(input.files); input.value = "";});
  ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, (ev) => {ev.preventDefault(); zone.classList.add("dragover");}));
  ["dragleave", "drop"].forEach(type => zone.addEventListener(type, (ev) => {ev.preventDefault(); zone.classList.remove("dragover");}));
  zone.addEventListener("drop", (ev) => addFiles(ev.dataTransfer.files));
  clear.addEventListener("click", () => {jobs = []; save(); render(); notice("История очищена в этом браузере. Задачи на сервере продолжают выполняться.");});
  document.querySelector("#year").textContent = new Date().getFullYear();
  load(); render(); jobs.forEach(refresh);
  setInterval(() => {if (!document.hidden) jobs.forEach(refresh);}, 3000);
})();
