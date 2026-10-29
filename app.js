(() => {
  "use strict";

  const STORAGE_KEY = "cell-spacer-board-v1";
  const TABLE = "cell_spacer_cells";
  const ACTIVITY_TABLE = "cell_spacer_activity";
  const BENCHES = [
    ...Array.from({ length: 16 }, (_, i) => `MLA ${i + 1}`), "MLA D1", "MLA D2",
    ...Array.from({ length: 4 }, (_, i) => `EMA ${i + 1}`),
  ];
  const PRODUCTS = ["MLA", "EMA"];
  const VARIABLE_TASKS = ["firewall", "xray"];
  const TASK_OPERATOR_LIMIT = 99;
  const FIXED_TASKS = [{ key: "cs01", operators: 2 }, { key: "cs02", operators: 1 }];
  const NOTE_KEYS = [
    ...BENCHES,
    ...VARIABLE_TASKS.map((task) => `task:${task}`),
    ...FIXED_TASKS.map((task) => `task:${task.key}`),
  ];
  const SHIFT_ORDER = ["AM", "PM", "Nights"];
  const SHIFT_COLOR_ANCHOR = "2026-10-26";
  const FALLBACK = { shifts: {}, loadedShifts: {}, currentId: null, cellTimestamps: {}, activity: [], config: null };

  let state = loadState();
  let activityItems = [...state.activity];
  let activeFilter = "ALL";
  let client = null;
  let liveChannel = null;
  let activityChannel = null;
  let connected = false;
  let activityLoading = false;
  let activityOffset = 0;
  let activityHasMore = false;
  let activityError = "";
  let activityLive = false;
  let activitySidebarOpen = false;
  let detectedDeviceLabel = "";
  let syncChain = Promise.resolve();
  const writeTimers = new Map();
  const countActivityTimers = new Map();
  const pendingCountActivity = new Map();
  const sessionLoadedShiftIds = new Set();
  let toastTimer = null;

  const el = (id) => document.getElementById(id);
  const dateInput = el("productionDate");
  const shiftSelect = el("shiftSelect");
  const table = el("productionTable");
  const mobileBoard = el("mobileBoard");
  const deviceId = getDeviceId();

  function getDeviceId() {
    const key = "cell-spacer-board-device-id";
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(key, id);
      }
      return id;
    } catch (error) {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function deviceLabel() {
    if (detectedDeviceLabel) return detectedDeviceLabel;
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const kind = deviceKind(ua);
    const os = deviceOperatingSystem(ua, platform);
    const browser = browserName(ua, navigator.userAgentData?.brands || []);
    const model = modelName("") || modelFromUserAgent(ua);
    if (kind === "Phone") return [os, model, browser].filter(Boolean).join(" · ") || "Phone";
    if (kind === "Tablet") return [os, model || "Tablet", browser].filter(Boolean).join(" · ") || "Tablet";
    const computer = os ? `${os} computer` : "Computer";
    return [computer, browser].filter(Boolean).join(" · ");
  }

  function deviceKind(ua) {
    if (/iPhone|Android.*Mobile|Windows Phone|\bMobile\b/i.test(ua)) return "Phone";
    if (/iPad|Tablet|Android/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "Tablet";
    return "Computer";
  }

  function deviceOperatingSystem(ua, platform) {
    if (/Android/i.test(`${platform} ${ua}`)) return "Android";
    if (/iPhone|iPad|iPod|CPU (?:iPhone )?OS/i.test(ua) || /iPhone|iPad|iPod/i.test(platform) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "iOS";
    if (/Windows|Win32|Win64/i.test(`${platform} ${ua}`)) return "Windows";
    if (/CrOS|Chrome OS/i.test(`${platform} ${ua}`)) return "ChromeOS";
    if (/Macintosh|Mac OS|macOS/i.test(`${platform} ${ua}`)) return "macOS";
    if (/Linux/i.test(`${platform} ${ua}`)) return "Linux";
    return "";
  }

  function browserName(ua, brands) {
    if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet";
    if (/EdgA?\/|EdgiOS\//i.test(ua)) return "Microsoft Edge";
    if (/OPR\/|OPT\//i.test(ua)) return "Opera";
    if (/FxiOS\/|Firefox\//i.test(ua)) return "Firefox";
    if (/CriOS\/|Chrome\//i.test(ua)) return "Google Chrome";
    if (/Safari\//i.test(ua) || /Version\/.*Safari/i.test(ua)) return "Safari";
    const brandList = brands.map((item) => item.brand).join(" ");
    if (/Microsoft Edge/i.test(brandList)) return "Microsoft Edge";
    if (/Google Chrome/i.test(brandList)) return "Google Chrome";
    if (/Firefox/i.test(brandList)) return "Firefox";
    if (/Opera/i.test(brandList)) return "Opera";
    if (/Safari/i.test(brandList)) return "Safari";
    return "";
  }

  function modelFromUserAgent(ua) {
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (!/Android/i.test(ua)) return "";
    const match = ua.match(/Android[^;)]*;\s*([^;)]+)/i);
    if (!match) return "";
    const model = match[1].replace(/\s+Build\/.*$/i, "").replace(/,.*$/, "").trim();
    return /^(?:k|unknown|android|mobile|wv)$/i.test(model) ? "" : model;
  }

  function modelName(model) {
    const cleaned = String(model || "").trim().replace(/\s+Build\/.*$/i, "");
    return /^(?:k|unknown|android|mobile|wv)$/i.test(cleaned) ? "" : cleaned;
  }

  function trackDevicePresence() {
    if (!connected || !liveChannel) return;
    liveChannel.track({ deviceId, deviceLabel: deviceLabel(), connectedAt: new Date().toISOString() })
      .then(renderPresence)
      .catch((error) => console.warn("Could not update this device's presence label", error));
  }

  async function refreshDeviceLabel() {
    const uaData = navigator.userAgentData;
    let model = "";
    if (uaData?.getHighEntropyValues) {
      try {
        const hints = await uaData.getHighEntropyValues(["model"]);
        model = modelName(hints.model);
      } catch (error) {
        console.debug("Device model hint is unavailable", error);
      }
    }
    const ua = navigator.userAgent || "";
    const platform = uaData?.platform || navigator.platform || "";
    const kind = deviceKind(ua);
    const os = deviceOperatingSystem(ua, platform);
    const browser = browserName(ua, uaData?.brands || []);
    const detectedModel = model || modelFromUserAgent(ua);
    if (kind === "Phone") detectedDeviceLabel = [os, detectedModel, browser].filter(Boolean).join(" · ") || "Phone";
    else if (kind === "Tablet") detectedDeviceLabel = [os, detectedModel || "Tablet", browser].filter(Boolean).join(" · ") || "Tablet";
    else detectedDeviceLabel = [os ? `${os} computer` : "Computer", browser].filter(Boolean).join(" · ");

    trackDevicePresence();
    renderPresence();
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        return {
          ...FALLBACK,
          ...saved,
          shifts: saved.shifts && typeof saved.shifts === "object" ? saved.shifts : {},
          loadedShifts: saved.loadedShifts && typeof saved.loadedShifts === "object" ? saved.loadedShifts : Object.fromEntries(Object.keys(saved.shifts || {}).map((id) => [id, true])),
          cellTimestamps: saved.cellTimestamps && typeof saved.cellTimestamps === "object" ? saved.cellTimestamps : {},
          activity: Array.isArray(saved.activity) ? saved.activity : [],
        };
      }
    } catch (error) {
      console.warn("Could not read saved board data", error);
    }
    return structuredClone(FALLBACK);
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      setSyncState("error", "Could not save on this device");
      console.error("Could not save board locally", error);
    }
  }

  function newActivityId() {
    return globalThis.crypto?.randomUUID?.() || `${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function activitySort(rows) {
    return rows.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  }

  function mergeActivityRows(rows) {
    const byId = new Map(activityItems.map((item) => [item.id, item]));
    for (const row of rows || []) {
      if (!row?.id) continue;
      byId.set(row.id, { ...byId.get(row.id), ...row, _pending: false });
    }
    activityItems = activitySort([...byId.values()]);
    const pending = activityItems.filter((item) => item._pending);
    state.activity = [...pending, ...activityItems.filter((item) => !item._pending).slice(0, 200)].slice(0, 300);
    saveLocal();
    renderActivity();
  }

  function addActivity(shift, action, summary, details = {}) {
    const item = {
      id: newActivityId(),
      created_at: new Date().toISOString(),
      shift_id: shift.id,
      actor_label: deviceLabel(),
      action,
      summary,
      details,
      _pending: true,
    };
    mergeActivityRows([item]);
    if (connected) persistActivity(item).catch((error) => {
      activityError = activityErrorText(error);
      renderActivity();
    });
    return item;
  }

  function activityPayload(item) {
    return {
      id: item.id,
      created_at: item.created_at,
      shift_id: item.shift_id,
      actor_label: item.actor_label,
      action: item.action,
      summary: item.summary,
      details: item.details || {},
    };
  }

  async function persistActivity(item) {
    if (!connected || !client) return;
    const { error } = await client.from(ACTIVITY_TABLE).upsert(activityPayload(item), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
    mergeActivityRows([activityPayload(item)]);
    activityError = "";
    renderActivity();
  }

  async function flushPendingActivity() {
    if (!connected || !client) return;
    const pending = state.activity.filter((item) => item._pending);
    for (const item of pending) {
      try {
        await persistActivity(item);
      } catch (error) {
        activityError = activityErrorText(error);
        renderActivity();
        return;
      }
    }
  }

  function activityErrorText(error) {
    const message = String(error?.message || error || "Could not sync activity history.");
    return /cell_spacer_activity|schema cache|does not exist|relation/i.test(message)
      ? "The shared activity table is not installed yet. Run supabase-activity-log.sql once in the Supabase SQL Editor."
      : `Activity history could not sync: ${message}`;
  }

  function queueCountActivity(shift, bench, hour, previous, next) {
    const key = cellId(shift, bench, hour);
    const pending = pendingCountActivity.get(key) || { shift, bench, hour, previous };
    pending.next = next;
    pendingCountActivity.set(key, pending);
    clearTimeout(countActivityTimers.get(key));
    countActivityTimers.set(key, setTimeout(() => commitCountActivity(key), 850));
  }

  function commitCountActivity(key) {
    clearTimeout(countActivityTimers.get(key));
    countActivityTimers.delete(key);
    const pending = pendingCountActivity.get(key);
    if (!pending) return;
    pendingCountActivity.delete(key);
    if (Object.is(pending.previous, pending.next)) return;
    const from = pending.previous === null || pending.previous === undefined ? "blank" : pending.previous;
    const to = pending.next === null || pending.next === undefined ? "blank" : pending.next;
    addActivity(pending.shift, "count", `${pending.bench} · Hour ${pending.hour + 1}: ${from} → ${to}`, {
      bench: pending.bench,
      hour: pending.hour + 1,
      from: pending.previous ?? null,
      to: pending.next ?? null,
    });
  }

  function flushCountActivityForInput(input) {
    const shift = activeShift();
    if (!shift) return;
    commitCountActivity(cellId(shift, input.dataset.bench, Number(input.dataset.hour)));
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dayNumber(dateText) {
    return new Date(`${dateText}T12:00:00`).getDay();
  }

  function shiftForNow(dateText, now = new Date()) {
    const hour = now.getHours();
    const day = dayNumber(dateText);
    if (day === 5) {
      if (hour < 13) return "AM";
      if (hour < 20) return "PM";
      return "Nights";
    }
    if (day === 0) {
      if (hour >= 23 || hour < 6) return "Nights";
      if (hour < 14) return "AM";
      if (hour < 22) return "PM";
      return "Nights";
    }
    if (hour >= 22 || hour < 6) return "Nights";
    if (hour < 14) return "AM";
    return "PM";
  }

  function getSchedule(dateText, shiftName) {
    const day = dayNumber(dateText);
    let start;
    let length;
    if (shiftName === "AM") {
      start = 6;
      length = day === 5 ? 7 : 8;
    } else if (shiftName === "PM") {
      start = day === 5 ? 13 : 14;
      length = day === 5 ? 7 : 8;
    } else {
      start = day === 0 ? 23 : 22;
      length = day === 0 ? 7 : 8;
    }
    const hours = Array.from({ length }, (_, index) => {
      const from = (start + index) % 24;
      const to = (from + 1) % 24;
      return { index, from, to, break: index === 4 };
    });
    return { start, end: (start + length) % 24, length, hours };
  }

  function shiftTeamName(dateText, shiftName) {
    if (shiftName === "Nights") return "Green";
    const [year, month, day] = dateText.split("-").map(Number);
    const dateUtc = Date.UTC(year, month - 1, day);
    const weekday = new Date(dateUtc).getUTCDay();
    const mondayUtc = dateUtc - ((weekday + 6) % 7) * 86400000;
    const [anchorYear, anchorMonth, anchorDay] = SHIFT_COLOR_ANCHOR.split("-").map(Number);
    const anchorUtc = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);
    const weekOffset = Math.floor((mondayUtc - anchorUtc) / (7 * 86400000));
    const anchorWeek = ((weekOffset % 2) + 2) % 2 === 0;
    const isRed = shiftName === "PM" ? anchorWeek : !anchorWeek;
    return isRed ? "Red" : "Blue";
  }

  function shiftTeamEmoji(team) {
    return team === "Red" ? "🔴" : team === "Blue" ? "🔵" : "🟢";
  }

  function timeText(hour) {
    return `${String(hour).padStart(2, "0")}:00`;
  }

  function shiftId(dateText, shiftName) {
    return `${dateText}_${shiftName}`;
  }

  function parseShiftId(id) {
    const underscore = id.indexOf("_");
    return { date: id.slice(0, underscore), shift: id.slice(underscore + 1) };
  }

  function blankShift(dateText, shiftName) {
    const schedule = getSchedule(dateText, shiftName);
    return {
      id: shiftId(dateText, shiftName),
      date: dateText,
      shift: shiftName,
      finalized: false,
      createdAt: new Date().toISOString(),
      entries: Object.fromEntries(BENCHES.map((bench) => [bench, Array(schedule.length).fill(null)])),
      hourDisabled: Object.fromEntries(BENCHES.map((bench) => [bench, Array(schedule.length).fill(false)])),
      singleOp: Object.fromEntries(BENCHES.map((bench) => [bench, false])),
      inactive: Object.fromEntries(BENCHES.map((bench) => [bench, false])),
      taskOperators: { firewall: 0, xray: 0, cs01: true, cs02: true },
      notes: Object.fromEntries(NOTE_KEYS.map((key) => [key, ""])),
    };
  }

  function normalizeTaskOperatorCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.min(TASK_OPERATOR_LIMIT, Math.trunc(count))) : 0;
  }

  function taskOperatorCount(shift, task) {
    return normalizeTaskOperatorCount(shift?.taskOperators?.[task]);
  }

  function fixedTaskIncluded(shift, task) {
    return shift?.taskOperators?.[task] !== false;
  }

  function operatorEstimate(shift) {
    const benchOperators = BENCHES.reduce((count, bench) => {
      if (shift.inactive[bench]) return count;
      return count + (shift.singleOp[bench] ? 1 : 2);
    }, 0);
    const fixedOperators = FIXED_TASKS.reduce((count, task) => count + (fixedTaskIncluded(shift, task.key) ? task.operators : 0), 0);
    const taskOperators = VARIABLE_TASKS.reduce((count, task) => count + taskOperatorCount(shift, task), fixedOperators);
    return { benchOperators, taskOperators, total: benchOperators + taskOperators };
  }

  function activeShift() {
    return state.shifts[state.currentId] || null;
  }

  function cellId(shift, bench = null, hour = null) {
    if (bench === null) return `${shift.id}::meta`;
    if (hour === "note") return `${shift.id}::${bench}::note`;
    if (hour === null) return `${shift.id}::${bench}::status`;
    return `${shift.id}::${bench}::h${hour}`;
  }

  function cellValue(shift, key) {
    const parts = key.split("::");
    const kind = parts[1];
    if (!shift) return undefined;
    if (kind === "meta") {
      return {
        date: shift.date,
        shift: shift.shift,
        finalized: !!shift.finalized,
        createdAt: shift.createdAt,
        taskOperators: {
          ...Object.fromEntries(VARIABLE_TASKS.map((task) => [task, taskOperatorCount(shift, task)])),
          ...Object.fromEntries(FIXED_TASKS.map((task) => [task.key, fixedTaskIncluded(shift, task.key)])),
        },
      };
    }
    const bench = parts[1];
    if (parts[2] === "note" && NOTE_KEYS.includes(bench)) {
      return { note: String(shift.notes?.[bench] || "").slice(0, 15) };
    }
    if (parts[2] === "status") {
      return { singleOp: !!shift.singleOp[bench], inactive: !!shift.inactive[bench] };
    }
    const index = Number(parts[2].slice(1));
    return { count: shift.entries[bench]?.[index] ?? null, disabled: !!shift.hourDisabled[bench]?.[index] };
  }

  function cellValueForKey(key) {
    const shiftIdValue = key.split("::")[0];
    return cellValue(state.shifts[shiftIdValue], key);
  }

  function shouldSyncCell(shift, key) {
    if (key === cellId(shift) || state.cellTimestamps[key]) return true;
    const parts = key.split("::");
    if (parts[2] === "status") {
      return !!shift.singleOp[parts[1]] || !!shift.inactive[parts[1]];
    }
    if (parts[2] === "note" && NOTE_KEYS.includes(parts[1])) return !!shift.notes?.[parts[1]];
    if (parts[2]?.startsWith("h")) {
      const index = Number(parts[2].slice(1));
      const count = shift.entries[parts[1]]?.[index];
      return (count !== null && count !== undefined) || !!shift.hourDisabled[parts[1]]?.[index];
    }
    return false;
  }

  function touchCell(shift, key) {
    const timestamp = new Date().toISOString();
    state.cellTimestamps[key] = timestamp;
    saveLocal();
    if (connected) queueWrite(key, timestamp);
  }

  function seedLocalTimestamps(shift) {
    const key = cellId(shift);
    if (!state.cellTimestamps[key]) state.cellTimestamps[key] = shift.createdAt || new Date().toISOString();
  }

  function allCellKeys(shift) {
    const schedule = getSchedule(shift.date, shift.shift);
    const keys = [cellId(shift)];
    for (const bench of BENCHES) {
      keys.push(cellId(shift, bench));
      keys.push(cellId(shift, bench, "note"));
      for (let hour = 0; hour < schedule.length; hour += 1) keys.push(cellId(shift, bench, hour));
    }
    for (const key of NOTE_KEYS.filter((item) => item.startsWith("task:"))) keys.push(cellId(shift, key, "note"));
    return keys;
  }

  function ensureShift(dateText, shiftName) {
    const id = shiftId(dateText, shiftName);
    if (!state.shifts[id]) {
      const shift = blankShift(dateText, shiftName);
      state.shifts[id] = shift;
      state.loadedShifts[id] = true;
      if (connected) touchCell(shift, cellId(shift));
      else saveLocal();
      addActivity(shift, "shift_created", `${shiftName} shift board created`, { productionDate: dateText, shift: shiftName });
    }
    return state.shifts[id];
  }

  function chooseShift(dateText, shiftName) {
    const shift = ensureShift(dateText, shiftName);
    state.currentId = shift.id;
    saveLocal();
    render();
    if (connected && !sessionLoadedShiftIds.has(shift.id)) {
      loadShiftDetails(shift.id).catch((error) => {
        console.error("Could not load shift details", error);
        showToast("Could not load this shift from the shared board. Check your connection and try again.");
      });
    }
  }

  function readRemoteIntoLocal(row) {
    const parts = row.id.split("::");
    if (parts.length < 2) return null;
    const id = parts[0];
    if (!state.shifts[id]) {
      const parsed = parseShiftId(id);
      state.shifts[id] = blankShift(parsed.date, parsed.shift);
      state.loadedShifts[id] = false;
    }
    const shift = state.shifts[id];
    const value = row.value && typeof row.value === "object" ? row.value : {};
    if (parts[1] === "meta") {
      shift.finalized = !!value.finalized;
      shift.createdAt = value.createdAt || shift.createdAt;
      if (value.taskOperators && typeof value.taskOperators === "object") {
        shift.taskOperators = {
          ...shift.taskOperators,
          ...Object.fromEntries(VARIABLE_TASKS.map((task) => [task, normalizeTaskOperatorCount(value.taskOperators[task])])),
          ...Object.fromEntries(FIXED_TASKS.map((task) => [
            task.key,
            value.taskOperators[task.key] === undefined ? fixedTaskIncluded(shift, task.key) : !!value.taskOperators[task.key],
          ])),
        };
      }
    } else if (parts[2] === "note" && NOTE_KEYS.includes(parts[1])) {
      shift.notes ||= {};
      shift.notes[parts[1]] = String(value.note || "").slice(0, 15);
    } else if (parts[2] === "status" && BENCHES.includes(parts[1])) {
      shift.singleOp[parts[1]] = !!value.singleOp;
      shift.inactive[parts[1]] = !!value.inactive;
    } else if (parts[2]?.startsWith("h") && BENCHES.includes(parts[1])) {
      const index = Number(parts[2].slice(1));
      if (Number.isInteger(index) && index >= 0 && index < getSchedule(shift.date, shift.shift).length) {
        shift.entries[parts[1]][index] = value.count === null || value.count === undefined ? null : Number(value.count);
        shift.hourDisabled[parts[1]][index] = !!value.disabled;
      }
    } else {
      return null;
    }
    return { shift, key: row.id };
  }

  function getBenchResult(shift, bench) {
    const schedule = getSchedule(shift.date, shift.shift);
    if (shift.inactive[bench]) return { inactive: true, complete: true, done: 0, required: 0, total: null };
    const requiredHours = schedule.hours.filter((hour) => !shift.hourDisabled[bench][hour.index]);
    const done = requiredHours.filter((hour) => shift.entries[bench][hour.index] !== null && shift.entries[bench][hour.index] !== undefined).length;
    const complete = done === requiredHours.length;
    const total = complete ? requiredHours.reduce((sum, hour) => sum + Number(shift.entries[bench][hour.index] || 0), 0) : null;
    return { inactive: false, complete, done, required: requiredHours.length, total };
  }

  function productBenchResult(shift, product) {
    const benches = BENCHES.filter((bench) => bench.startsWith(`${product} `));
    const results = benches.map((bench) => ({ bench, ...getBenchResult(shift, bench) }));
    const complete = results.every((result) => result.complete);
    const total = complete ? results.reduce((sum, result) => sum + (result.inactive ? 0 : result.total), 0) : null;
    return { benches, results, complete, total };
  }

  function shiftProgress(shift) {
    const schedule = getSchedule(shift.date, shift.shift);
    let required = 0;
    let done = 0;
    for (const bench of BENCHES) {
      if (shift.inactive[bench]) continue;
      for (const hour of schedule.hours) {
        if (shift.hourDisabled[bench][hour.index]) continue;
        required += 1;
        if (shift.entries[bench][hour.index] !== null && shift.entries[bench][hour.index] !== undefined) done += 1;
      }
    }
    return { done, required, complete: done === required };
  }

  function goalFor(shift, bench, index) {
    let goal = shift.singleOp[bench] ? 60 : 120;
    if (index === 4) goal /= 2;
    return goal;
  }

  function countClass(shift, bench, index, count) {
    if (count === null || count === undefined || count === "") return "";
    return Number(count) >= goalFor(shift, bench, index) ? "is-target" : "is-under";
  }

  function formatNumber(value) {
    return Number(value).toLocaleString("en-GB");
  }

  function shortDate(dateText) {
    const date = new Date(`${dateText}T12:00:00`);
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(date);
  }

  function safe(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function shiftPerformance(shift, schedule) {
    let actual = 0;
    let target = 0;
    let enteredHours = 0;
    const products = Object.fromEntries(PRODUCTS.map((product) => [product, { actual: 0, target: 0, enteredHours: 0 }]));
    const benchPerformance = new Map();
    for (const bench of BENCHES) {
      if (shift.inactive[bench]) continue;
      let total = 0;
      let benchTarget = 0;
      let hours = 0;
      const product = bench.startsWith("MLA ") ? "MLA" : "EMA";
      for (const hour of schedule.hours) {
        if (shift.hourDisabled[bench][hour.index]) continue;
        const count = shift.entries[bench][hour.index];
        if (count === null || count === undefined || count === "") continue;
        const numericCount = Number(count);
        if (!Number.isFinite(numericCount)) continue;
        total += numericCount;
        const hourTarget = goalFor(shift, bench, hour.index);
        benchTarget += hourTarget;
        products[product].actual += numericCount;
        products[product].target += hourTarget;
        products[product].enteredHours += 1;
        target += hourTarget;
        actual += numericCount;
        hours += 1;
        enteredHours += 1;
      }
      if (hours && benchTarget) benchPerformance.set(bench, { attainment: total / benchTarget * 100 });
    }
    const attainment = target ? actual / target * 100 : 0;
    const averages = new Map(PRODUCTS.map((product) => {
      const totals = products[product];
      return [product, totals.enteredHours ? totals.actual / totals.enteredHours : null];
    }));
    return { actual, target, enteredHours, attainment, averages, benchPerformance };
  }

  function formatAverage(value) {
    return Number(value).toLocaleString("en-GB", { maximumFractionDigits: 1 });
  }

  function renderShiftPerformance(shift, schedule) {
    const metrics = shiftPerformance(shift, schedule);
    const attainment = el("shiftAttainment");
    attainment.textContent = `${formatAverage(metrics.attainment)}%`;
    attainment.dataset.level = metrics.attainment >= 100 ? "green" : metrics.attainment >= 90 ? "yellow" : "red";
    el("attainmentDetail").textContent = `${formatNumber(metrics.actual)} of ${formatNumber(metrics.target)} target parts · ${metrics.enteredHours} entered ${metrics.enteredHours === 1 ? "hour" : "hours"}`;

    const leaders = new Set();
    for (const product of PRODUCTS) {
      const benches = BENCHES.filter((bench) => bench.startsWith(`${product} `));
      const average = metrics.averages.get(product);
      el(`${product.toLowerCase()}BenchAverage`).textContent = average === null ? "—" : formatAverage(average);
      const current = benches.filter((bench) => metrics.benchPerformance.has(bench));
      if (current.length) {
        const highest = Math.max(...current.map((bench) => metrics.benchPerformance.get(bench).attainment));
        for (const bench of current) {
          if (Math.abs(metrics.benchPerformance.get(bench).attainment - highest) < 1e-9) leaders.add(bench);
        }
      }
    }
    for (const row of document.querySelectorAll("[data-bench-row]")) {
      const isLeader = leaders.has(row.dataset.benchRow);
      row.classList.toggle("is-best-bench", isLeader);
      const badge = row.querySelector("[data-best-bench-badge]");
      if (badge) badge.hidden = !isLeader;
    }
  }

  function render() {
    const shift = activeShift();
    if (!shift) return;
    const schedule = getSchedule(shift.date, shift.shift);
    dateInput.value = shift.date;
    shiftSelect.value = shift.shift;
    el("dateDay").textContent = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(`${shift.date}T12:00:00`));
    el("shiftTime").textContent = `${timeText(schedule.start)} — ${timeText(schedule.end)}`;
    el("shiftHours").innerHTML = `${schedule.length} hours <span>·</span> Hour 5 break`;
    const team = shiftTeamName(shift.date, shift.shift);
    const teamChip = el("shiftTeam");
    teamChip.className = `shift-team-chip team-${team.toLowerCase()}`;
    teamChip.setAttribute("aria-label", `${team} shift`);
    el("shiftTeamLabel").textContent = `${team} Shift`;
    renderHistory(shift);
    renderStatus(shift);
    renderTables(shift, schedule);
    refreshSummaries();
    el("shareButton").hidden = !connected;
    renderPresence();
    renderActivity();
  }

  function renderStatus(shift) {
    const status = el("shiftStatus");
    if (shift.finalized) {
      status.className = "shift-status finalized";
      status.innerHTML = '<span class="status-pulse"></span><span>SHIFT SAVED</span>';
    } else {
      status.className = "shift-status";
      status.innerHTML = '<span class="status-pulse"></span><span>IN PROGRESS</span>';
    }
    el("productionDate").disabled = false;
    el("shiftSelect").disabled = false;
  }

  function renderHistory(shift) {
    const select = el("historySelect");
    const ordered = Object.values(state.shifts).filter(shiftHasData).sort((a, b) => {
      const byDate = b.date.localeCompare(a.date);
      if (byDate) return byDate;
      return SHIFT_ORDER.indexOf(b.shift) - SHIFT_ORDER.indexOf(a.shift);
    });
    select.innerHTML = '<option value="">Shift history</option>' + ordered.map((item) => {
      const flag = item.finalized ? "Saved" : "In progress";
      const team = shiftTeamName(item.date, item.shift);
      const text = `${shortDate(item.date)} · ${item.shift} · ${shiftTeamEmoji(team)} ${team} · ${flag}`;
      return `<option value="${safe(item.id)}">${safe(text)}</option>`;
    }).join("");
    select.value = shift.id;
  }

  function renderTaskStaffing(shift) {
    for (const input of document.querySelectorAll("[data-note-key]")) {
      const key = input.dataset.noteKey;
      input.value = String(shift.notes?.[key] || "").slice(0, 15);
      const benchOff = BENCHES.includes(key) && !!shift.inactive[key];
      const taskKey = key.startsWith("task:") ? key.slice(5) : "";
      const taskOff = VARIABLE_TASKS.includes(taskKey)
        ? taskOperatorCount(shift, taskKey) === 0
        : FIXED_TASKS.some((task) => task.key === taskKey) && !fixedTaskIncluded(shift, taskKey);
      input.disabled = !!shift.finalized || benchOff || taskOff;
    }
    for (const input of document.querySelectorAll("[data-task-count]")) {
      const task = input.dataset.taskCount;
      input.value = taskOperatorCount(shift, task);
      input.disabled = !!shift.finalized;
    }
    for (const button of document.querySelectorAll("[data-task-step]")) {
      const task = button.dataset.task;
      const next = taskOperatorCount(shift, task) + Number(button.dataset.taskStep);
      button.disabled = !!shift.finalized || next < 0 || next > TASK_OPERATOR_LIMIT;
    }
    for (const input of document.querySelectorAll("[data-fixed-task]")) {
      const task = input.dataset.fixedTask;
      const details = FIXED_TASKS.find((item) => item.key === task);
      if (!details) continue;
      const included = fixedTaskIncluded(shift, task);
      input.checked = included;
      input.disabled = !!shift.finalized;
      input.setAttribute("aria-label", `Include ${details.operators} ${task.toUpperCase()} operator${details.operators === 1 ? "" : "s"} in this shift`);
      const status = document.querySelector(`[data-fixed-task-state="${task}"]`);
      if (status) {
        status.textContent = included ? "Included" : "Not scheduled";
        status.classList.toggle("not-scheduled", !included);
      }
    }
  }

  function statusInput(bench, status, checked, disabled, label) {
    const statusHelp = status === "single" ? "One operator for every hour of this shift; halves the target" : "Take this bench out of the entire shift";
    return `<label class="status-toggle ${status === "inactive" ? "disabled-toggle" : ""}" title="${statusHelp}"><input type="checkbox" data-action="${status}" data-bench="${safe(bench)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${safe(label)}: ${statusHelp}"><span>${label}</span></label>`;
  }

  function operatorNoteInput(shift, key, label, disabled, className = "") {
    const value = String(shift.notes?.[key] || "").slice(0, 15);
    return `<input class="operator-note ${className}" type="text" maxlength="15" autocomplete="off" value="${safe(value)}" placeholder="Operator names" data-note-key="${safe(key)}" data-note-label="${safe(label)}" aria-label="Operator names for ${safe(label)}, up to 15 characters" title="Operator names · 15 characters maximum" ${disabled ? "disabled" : ""}>`;
  }

  function renderTables(shift, schedule) {
    const columns = 3 + schedule.length;
    let html = '<colgroup><col style="width:220px"><col style="width:142px">';
    for (let i = 0; i < schedule.length; i += 1) html += '<col style="width:90px">';
    html += '<col style="width:96px"></colgroup><thead><tr><th><span class="table-heading-label">BENCH / OPS NOTE</span></th><th>OPERATOR STATUS</th>';
    for (const hour of schedule.hours) {
      html += `<th class="hour-col"><span class="hour-heading">Hour ${hour.index + 1}</span><span class="hour-time">${timeText(hour.from)}–${timeText(hour.to)}</span>${hour.break ? '<span class="break-label">BREAK</span>' : ""}</th>`;
    }
    html += '<th class="total-col">SHIFT TOTAL</th></tr></thead><tbody>';

    for (const product of PRODUCTS) {
      const benches = BENCHES.filter((bench) => bench.startsWith(`${product} `));
      html += `<tr class="group-row" data-product="${product}"><td colspan="${columns}">${product} BENCHES<span class="group-total-note">${benches.length} benches · 120 target / hr</span></td></tr>`;
      for (const bench of benches) {
        const result = getBenchResult(shift, bench);
        const disabled = !!shift.finalized;
        const off = !!shift.inactive[bench];
        html += `<tr class="bench-row ${off ? "off-shift" : ""}" data-product="${product}" data-bench-row="${safe(bench)}"><td class="bench-cell ${result.complete && !off ? "completed" : ""}"><div class="bench-name-line"><span class="bench-id">${safe(bench)}</span><span class="best-bench-badge" data-best-bench-badge hidden>TOP ${product}</span><span class="bench-completion" data-completion="${safe(bench)}">${off ? "OFF SHIFT" : `${result.done}/${result.required} hrs`}</span></div>${operatorNoteInput(shift, bench, bench, disabled || off, "bench-operator-note")}</td>`;
        html += `<td class="status-cell"><div class="status-controls">${statusInput(bench, "single", !!shift.singleOp[bench], disabled || off, "1 op")}${statusInput(bench, "inactive", off, disabled, "Off shift")}</div></td>`;
        for (const hour of schedule.hours) {
          const count = shift.entries[bench][hour.index];
          const hourDisabled = !!shift.hourDisabled[bench][hour.index];
          if (hourDisabled) {
            html += `<td class="count-cell hour-off"><div class="hour-control"><span>OFF</span><button type="button" class="hour-off-button is-off" data-action="hour-off" data-bench="${safe(bench)}" data-hour="${hour.index}" ${disabled || off ? "disabled" : ""} aria-label="Enable ${safe(bench)} hour ${hour.index + 1}">ON</button></div></td>`;
          } else {
          html += `<td class="count-cell"><div class="hour-control"><input class="count-input ${countClass(shift, bench, hour.index, count)}" type="text" inputmode="numeric" pattern="[0-9]{1,3}" autocomplete="off" value="${count === null ? "" : safe(count)}" placeholder="—" data-action="count" data-bench="${safe(bench)}" data-hour="${hour.index}" aria-label="${safe(bench)}, hour ${hour.index + 1}, target ${goalFor(shift, bench, hour.index)}, enter 0 to 999" ${disabled || off ? "disabled" : ""}><button type="button" class="hour-off-button" data-action="hour-off" data-bench="${safe(bench)}" data-hour="${hour.index}" ${disabled || off ? "disabled" : ""} aria-label="Exclude ${safe(bench)} hour ${hour.index + 1}" title="Exclude this hour">−</button></div></td>`;
          }
        }
        const totalText = off ? "OFF" : result.complete ? formatNumber(result.total) : `${result.done}/${result.required} hrs`;
        const totalClass = off ? "pending" : result.complete ? "" : "pending";
        html += `<td class="total-cell ${totalClass}" data-total-bench="${safe(bench)}">${totalText}</td></tr>`;
      }
      html += `<tr class="product-total-row" data-product="${product}"><td colspan="2">${product} HOURLY TOTAL</td>`;
      for (const hour of schedule.hours) html += `<td class="product-total-hour" data-hour-total="${product}:${hour.index}">0</td>`;
      html += `<td class="product-total-grand pending" data-grand-product="${product}">INCOMPLETE</td></tr>`;
    }
    html += "</tbody>";
    table.innerHTML = html;

    let mobile = "";
    for (const product of PRODUCTS) {
      const benches = BENCHES.filter((bench) => bench.startsWith(`${product} `));
      mobile += `<section class="mobile-group" data-product="${product}"><div class="mobile-group-head"><span>${product} BENCHES</span><span>${benches.length} benches · 120 / hr</span></div>`;
      for (const bench of benches) {
        const result = getBenchResult(shift, bench);
        const off = !!shift.inactive[bench];
        const disabled = !!shift.finalized;
        mobile += `<article class="mobile-bench-card ${off ? "off-shift" : ""}" data-bench-row="${safe(bench)}"><div class="mobile-bench-head"><div class="mobile-bench-info"><div class="mobile-bench-title"><strong>${safe(bench)}</strong><span class="best-bench-badge" data-best-bench-badge hidden>TOP ${product}</span><span data-completion="${safe(bench)}">${off ? "OFF SHIFT" : `${result.done}/${result.required} hrs`}</span></div>${operatorNoteInput(shift, bench, bench, disabled || off, "bench-operator-note")}</div><div class="mobile-status-controls">${statusInput(bench, "single", !!shift.singleOp[bench], disabled || off, "1 op")}${statusInput(bench, "inactive", off, disabled, "Off shift")}</div></div><div class="mobile-hours">`;
        for (const hour of schedule.hours) {
          const count = shift.entries[bench][hour.index];
          const hourOff = !!shift.hourDisabled[bench][hour.index];
          const goal = goalFor(shift, bench, hour.index);
          if (hourOff) {
            mobile += `<div class="mobile-hour-cell hour-off"><div class="mobile-hour-meta">H${hour.index + 1} ${hour.break ? '<span class="break-label">BRK</span>' : ""}</div><span class="mobile-hour-off-label">OFF</span><button type="button" class="hour-off-button is-off" data-action="hour-off" data-bench="${safe(bench)}" data-hour="${hour.index}" ${disabled || off ? "disabled" : ""} aria-label="Enable ${safe(bench)} hour ${hour.index + 1}">ON</button></div>`;
          } else {
            mobile += `<div class="mobile-hour-cell"><div class="mobile-hour-meta"><span>H${hour.index + 1} · ${timeText(hour.from)}</span>${hour.break ? '<span class="break-label">BRK</span>' : ""}</div><div class="mobile-hour-input-row"><input class="count-input ${countClass(shift, bench, hour.index, count)}" type="text" inputmode="numeric" pattern="[0-9]{1,3}" autocomplete="off" value="${count === null ? "" : safe(count)}" placeholder="—" data-action="count" data-bench="${safe(bench)}" data-hour="${hour.index}" aria-label="${safe(bench)}, hour ${hour.index + 1}, target ${goal}, enter 0 to 999" ${disabled || off ? "disabled" : ""}><button type="button" class="hour-off-button" data-action="hour-off" data-bench="${safe(bench)}" data-hour="${hour.index}" ${disabled || off ? "disabled" : ""} aria-label="Exclude ${safe(bench)} hour ${hour.index + 1}" title="Exclude this hour">−</button></div></div>`;
          }
        }
        const totalText = off ? "OFF SHIFT" : result.complete ? `${formatNumber(result.total)} parts` : "Waiting for all active hours";
        mobile += `</div><div class="mobile-bench-foot"><span>Shift total</span><strong class="${off || !result.complete ? "pending" : ""}" data-total-bench="${safe(bench)}">${totalText}</strong></div></article>`;
      }
      mobile += `<div class="mobile-hourly-totals"><strong>${product} hourly totals</strong><div class="mobile-total-grid">`;
      for (const hour of schedule.hours) {
        mobile += `<div class="mobile-total-item"><span>H${hour.index + 1}${hour.break ? " · break" : ""}</span><b data-hour-total="${product}:${hour.index}">0</b></div>`;
      }
      mobile += `</div></div>`;
      mobile += `<div class="mobile-product-total"><span>${product} SHIFT TOTAL</span><span class="pending" data-grand-product="${product}">INCOMPLETE</span></div></section>`;
    }
    mobileBoard.innerHTML = mobile;
    applyFilter();
    renderFinalizeState();
  }

  function applyFilter() {
    for (const button of document.querySelectorAll(".filter-button")) {
      const selected = button.dataset.filter === activeFilter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    }
    for (const item of document.querySelectorAll("[data-product]")) {
      item.hidden = activeFilter !== "ALL" && item.dataset.product !== activeFilter;
    }
  }

  function refreshSummaries() {
    const shift = activeShift();
    if (!shift) return;
    const schedule = getSchedule(shift.date, shift.shift);
    const progress = shiftProgress(shift);
    const operators = operatorEstimate(shift);
    el("operatorTotal").textContent = operators.total;
    el("operatorBreakdown").textContent = `${operators.benchOperators} at benches · ${operators.taskOperators} on other tasks`;
    renderTaskStaffing(shift);
    el("completionNote").classList.toggle("complete", progress.complete);
    el("completionNote").querySelector("span:last-child").textContent = progress.complete ? "All active hours are complete" : "Enter every active hour to unlock shift totals";
    renderShiftPerformance(shift, schedule);

    for (const bench of BENCHES) {
      const result = getBenchResult(shift, bench);
      for (const label of document.querySelectorAll(`[data-completion="${bench}"]`)) {
        label.textContent = result.inactive ? "OFF SHIFT" : `${result.done}/${result.required} hrs`;
      }
      const total = result.inactive ? "OFF" : result.complete ? formatNumber(result.total) : `${result.done}/${result.required} hrs`;
      for (const label of document.querySelectorAll(`[data-total-bench="${bench}"]`)) {
        label.textContent = result.inactive ? (label.closest(".mobile-bench-foot") ? "OFF SHIFT" : "OFF") : result.complete ? (label.closest(".mobile-bench-foot") ? `${formatNumber(result.total)} parts` : formatNumber(result.total)) : total;
        label.classList.toggle("pending", !result.complete || result.inactive);
      }
    }

    let allProductsComplete = true;
    for (const product of PRODUCTS) {
      const summary = productBenchResult(shift, product);
      allProductsComplete &&= summary.complete;
      el(`${product.toLowerCase()}GrandTotal`).textContent = summary.complete ? formatNumber(summary.total) : "—";
      el(`${product.toLowerCase()}BenchStatus`).textContent = `${summary.results.filter((result) => !result.inactive).length} active of ${summary.benches.length} benches`;
      for (const hour of schedule.hours) {
        const hourly = BENCHES.filter((bench) => bench.startsWith(`${product} `)).reduce((sum, bench) => {
          if (shift.inactive[bench] || shift.hourDisabled[bench][hour.index]) return sum;
          return sum + Number(shift.entries[bench][hour.index] || 0);
        }, 0);
        for (const total of document.querySelectorAll(`[data-hour-total="${product}:${hour.index}"]`)) total.textContent = formatNumber(hourly);
      }
      for (const total of document.querySelectorAll(`[data-grand-product="${product}"]`)) {
        total.textContent = summary.complete ? formatNumber(summary.total) : "INCOMPLETE";
        total.classList.toggle("pending", !summary.complete);
      }
    }

    for (const input of document.querySelectorAll('[data-action="count"]')) {
      const bench = input.dataset.bench;
      const index = Number(input.dataset.hour);
      input.classList.remove("is-target", "is-under");
      const statusClass = countClass(shift, bench, index, shift.entries[bench][index]);
      if (statusClass) input.classList.add(statusClass);
      const value = shift.entries[bench][index];
      input.value = value === null ? "" : value;
    }
    renderFinalizeState(progress, allProductsComplete);
  }

  function renderFinalizeState(progress = null) {
    const shift = activeShift();
    if (!shift) return;
    const result = progress || shiftProgress(shift);
    const allComplete = result.complete;
    const button = el("finalizeButton");
    const title = el("finalizeTitle");
    const message = el("finalizeMessage");
    if (shift.finalized) {
      title.textContent = "This shift is saved";
      message.textContent = "Final totals are saved in shift history. Reopen the shift to make a correction.";
      button.innerHTML = 'Reopen shift <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 7A6 6 0 0 0 5 5.5L3.5 7M3.5 7V3.5M3.5 7H7M4.5 13A6 6 0 0 0 15 14.5l1.5-1.5M16.5 13v3.5M16.5 13H13" /></svg>';
      button.disabled = false;
      button.className = "button button-quiet";
    } else {
      title.textContent = allComplete ? "All active counts are in" : "Ready when all counts are in";
      message.textContent = allComplete ? "Review the hourly totals, then save this shift to history." : `Complete all active bench hours to unlock shift totals. ${result.done} of ${result.required} entries are in.`;
      button.innerHTML = 'Finalize shift <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>';
      button.disabled = !allComplete;
      button.className = "button button-primary";
    }
  }

  function setSyncState(kind, label) {
    const root = el("syncState");
    root.className = `sync-state ${kind === "online" ? "is-online" : kind === "syncing" ? "is-syncing" : kind === "error" ? "is-error" : ""}`;
    el("syncLabel").textContent = label;
    el("footerSync").textContent = connected ? (kind === "error" ? "Sync needs attention" : kind === "syncing" ? "Syncing changes across devices…" : "Changes are live across devices") : "Changes save automatically on this device";
  }

  function renderPresence() {
    const button = el("presenceButton");
    if (!button) return;
    let devices = [];
    if (connected && liveChannel) {
      const presenceState = liveChannel.presenceState() || {};
      devices = Object.entries(presenceState).map(([key, metadata]) => {
        const latest = Array.isArray(metadata) ? metadata[metadata.length - 1] : metadata;
        return { key, label: latest?.deviceLabel || `Device · ${key.slice(-4).toUpperCase()}`, current: key === deviceId };
      }).sort((a, b) => Number(b.current) - Number(a.current) || a.label.localeCompare(b.label));
    }
    el("presenceCount").textContent = connected ? String(devices.length) : "—";
    el("presencePopoverCount").textContent = connected ? String(devices.length) : "—";
    button.title = connected ? `${devices.length} device${devices.length === 1 ? "" : "s"} connected` : "Connect the shared board to see devices";
    const list = el("presenceList");
    if (!connected) {
      list.innerHTML = '<li class="presence-empty">Connect the shared board to see devices.</li>';
    } else if (!devices.length) {
      list.innerHTML = '<li class="presence-empty">Waiting for connected devices…</li>';
    } else {
      list.innerHTML = devices.map((device) => `<li><span>${safe(device.label)}</span>${device.current ? "<small>THIS DEVICE</small>" : ""}</li>`).join("");
    }
  }

  function activityDateHeading(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (localDateString(date) === localDateString(today)) return "Today";
    if (localDateString(date) === localDateString(yesterday)) return "Yesterday";
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
  }

  function activityTime(timestamp) {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function renderActivity() {
    const status = el("activityStatus");
    const list = el("activityList");
    if (!status || !list) return;
    status.classList.toggle("is-error", !!activityError);
    if (activityError) status.textContent = activityError;
    else if (!connected) status.textContent = "Showing activity saved in this browser. Connect the shared board for live group history.";
    else if (activityLoading) status.textContent = "Loading shared activity…";
    else if (activityLive) status.textContent = "Live · new changes appear here";
    else status.textContent = activityItems.length ? "Recent shared activity" : "No shared activity recorded yet.";

    const rows = activitySort([...activityItems]);
    if (!rows.length) {
      list.innerHTML = `<li class="activity-empty">${connected ? "Changes made to the board will appear here." : "Changes on this device will appear here."}</li>`;
    } else {
      let previousDate = "";
      list.innerHTML = rows.map((row) => {
        const group = activityDateHeading(row.created_at);
        const heading = group === previousDate ? "" : `<li class="activity-day-heading">${safe(group)}</li>`;
        previousDate = group;
        const shift = state.shifts[row.shift_id];
        const parsedShift = parseShiftId(row.shift_id);
        const shiftDate = shift?.date || parsedShift.date;
        const shiftName = shift?.shift || parsedShift.shift;
        const team = shiftTeamName(shiftDate, shiftName);
        const shiftLabel = `${shortDate(shiftDate)} · ${shiftName} · ${shiftTeamEmoji(team)} ${team}`;
        const pendingLabel = row._pending ? " · waiting to sync" : "";
        return `${heading}<li class="activity-entry"><span class="activity-marker" aria-hidden="true"></span><button class="activity-entry-button" type="button" data-activity-shift="${safe(row.shift_id)}" title="Open ${safe(shiftLabel)}"><span class="activity-entry-main"><strong>${safe(row.summary || "Board updated")}</strong><time datetime="${safe(row.created_at)}" title="${safe(new Date(row.created_at).toLocaleString())}">${safe(activityTime(row.created_at))}</time></span><span class="activity-entry-meta">${safe(shiftLabel)} · ${safe(row.actor_label || "Device")}${safe(pendingLabel)}</span></button></li>`;
      }).join("");
    }
    const more = el("activityMoreButton");
    more.hidden = !connected || !activityHasMore;
    more.disabled = activityLoading;
    more.textContent = activityLoading ? "Loading…" : "Load older activity";
  }

  function startActivityRealtime() {
    if (!connected || !client || activityChannel) return;
    const suffix = `${deviceId.slice(-5)}-${Math.random().toString(36).slice(2, 6)}`;
    activityChannel = client.channel(`cell-spacer-activity-${suffix}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: ACTIVITY_TABLE }, (payload) => {
        if (payload.new?.id) mergeActivityRows([payload.new]);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          activityLive = true;
          activityError = "";
          renderActivity();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          activityLive = false;
          activityError = "Live activity updates are unavailable. The log can still be refreshed when you reopen it.";
          renderActivity();
        }
      });
  }

  async function loadActivityPage(reset = false) {
    if (!connected || !client || activityLoading) {
      renderActivity();
      return;
    }
    if (reset) {
      activityOffset = 0;
      activityHasMore = false;
      activityItems = [...state.activity];
    }
    activityLoading = true;
    activityError = "";
    renderActivity();
    const start = activityOffset;
    try {
      const { data, error } = await client.from(ACTIVITY_TABLE)
        .select("id,created_at,shift_id,actor_label,action,summary,details")
        .order("created_at", { ascending: false })
        .range(start, start + 49);
      if (error) throw error;
      mergeActivityRows(data || []);
      activityOffset += (data || []).length;
      activityHasMore = (data || []).length === 50;
    } catch (error) {
      activityError = activityErrorText(error);
    } finally {
      activityLoading = false;
      renderActivity();
    }
  }

  function openActivitySidebar() {
    if (activitySidebarOpen) return;
    activitySidebarOpen = true;
    const sidebar = el("activitySidebar");
    const backdrop = el("activityBackdrop");
    sidebar.inert = false;
    sidebar.setAttribute("aria-hidden", "false");
    sidebar.classList.add("is-open");
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
    el("activityButton").setAttribute("aria-expanded", "true");
    document.body.classList.add("activity-open");
    renderActivity();
    el("activityCloseButton").focus();
    if (connected) {
      startActivityRealtime();
      loadActivityPage(true);
      flushPendingActivity();
    }
  }

  function closeActivitySidebar() {
    if (!activitySidebarOpen) return;
    activitySidebarOpen = false;
    const sidebar = el("activitySidebar");
    const backdrop = el("activityBackdrop");
    sidebar.classList.remove("is-open");
    sidebar.setAttribute("aria-hidden", "true");
    sidebar.inert = true;
    backdrop.classList.remove("is-open");
    setTimeout(() => { if (!activitySidebarOpen) backdrop.hidden = true; }, 240);
    el("activityButton").setAttribute("aria-expanded", "false");
    document.body.classList.remove("activity-open");
    activityChannel?.unsubscribe();
    activityChannel = null;
    activityLive = false;
    el("activityButton").focus();
  }

  function openShiftFromActivity(id) {
    let shift = state.shifts[id];
    if (!shift) {
      const parsed = parseShiftId(id);
      shift = blankShift(parsed.date, parsed.shift);
      state.shifts[id] = shift;
      state.loadedShifts[id] = false;
    }
    state.currentId = id;
    saveLocal();
    render();
    closeActivitySidebar();
    if (connected && !sessionLoadedShiftIds.has(id)) {
      loadShiftDetails(id).catch((error) => {
        console.error("Could not load shift from activity history", error);
        showToast("Could not load this shift from the shared board. Check your connection and try again.");
      });
    }
  }

  function showToast(message) {
    const toast = el("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3400);
  }

  function queueWrite(key, timestamp) {
    if (!client || !connected) return;
    setSyncState("syncing", "Syncing live board…");
    clearTimeout(writeTimers.get(key));
    const timer = setTimeout(() => {
      writeTimers.delete(key);
      const row = { id: key, value: cellValueForKey(key), updated_at: state.cellTimestamps[key] || timestamp };
      syncChain = syncChain.then(async () => {
        if (!client || !connected) return;
        const { error } = await client.from(TABLE).upsert(row, { onConflict: "id" });
        if (error) throw error;
      }).then(() => {
        if (writeTimers.size === 0) setSyncState("online", "Live · all devices");
      }).catch((error) => {
        console.error("Board sync failed", error);
        setSyncState("error", "Sync issue · tap to reconnect");
      });
    }, 300);
    writeTimers.set(key, timer);
  }

  async function fetchCells(pattern = null) {
    const pageSize = 1000;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      let query = client.from(TABLE).select("id,value,updated_at");
      if (pattern !== null) query = query.like("id", pattern);
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return rows;
    }
  }

  function fetchShiftMetadata() {
    return fetchCells("%::meta");
  }

  function fetchShiftCells(id) {
    return fetchCells(`${id}::%`);
  }

  function fetchAllCells() {
    return fetchCells();
  }

  function mergeRemoteRows(rows) {
    const remote = new Map((rows || []).map((row) => [row.id, row]));
    for (const row of rows || []) {
      const localTime = state.cellTimestamps[row.id] ? Date.parse(state.cellTimestamps[row.id]) : 0;
      const remoteTime = Date.parse(row.updated_at || "1970-01-01T00:00:00Z");
      if (remoteTime > localTime || !state.cellTimestamps[row.id]) {
        const applied = readRemoteIntoLocal(row);
        if (applied) state.cellTimestamps[row.id] = row.updated_at || new Date().toISOString();
      }
    }
    return remote;
  }

  async function syncLocalShiftCells(shift, remoteRows) {
    if (!client || !connected) return;
    const remote = new Map((remoteRows || []).map((row) => [row.id, row]));
    seedLocalTimestamps(shift);
    const pending = [];
    for (const key of allCellKeys(shift)) {
      if (!shouldSyncCell(shift, key)) continue;
      const existing = remote.get(key);
      const localTime = Date.parse(state.cellTimestamps[key] || "1970-01-01T00:00:00Z");
      const remoteTime = existing ? Date.parse(existing.updated_at || "1970-01-01T00:00:00Z") : 0;
      if (!existing || localTime > remoteTime) pending.push({ id: key, value: cellValue(shift, key), updated_at: state.cellTimestamps[key] });
    }
    for (let start = 0; start < pending.length; start += 500) {
      const rows = pending.slice(start, start + 500).map((row) => {
        const latestTimestamp = state.cellTimestamps[row.id];
        return latestTimestamp && Date.parse(latestTimestamp) > Date.parse(row.updated_at)
          ? { id: row.id, value: cellValueForKey(row.id), updated_at: latestTimestamp }
          : row;
      });
      const { error } = await client.from(TABLE).upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    saveLocal();
  }

  async function loadShiftDetails(id) {
    if (!connected || !client || sessionLoadedShiftIds.has(id)) return;
    const shift = state.shifts[id];
    if (!shift) return;
    const rows = await fetchShiftCells(id);
    mergeRemoteRows(rows);
    state.loadedShifts[id] = true;
    sessionLoadedShiftIds.add(id);
    await syncLocalShiftCells(shift, rows);
    if (state.currentId === id) render();
  }

  function stopCloudConnection() {
    connected = false;
    liveChannel?.unsubscribe();
    liveChannel = null;
    activityChannel?.unsubscribe();
    activityChannel = null;
    activityLive = false;
    client = null;
    renderPresence();
    renderActivity();
  }

  async function connectToCloud(config) {
    if (!window.supabase?.createClient) throw new Error("The Supabase client did not load. Check your internet connection and refresh the page.");
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(config.url)) throw new Error("Enter a valid Supabase Project URL, such as https://your-project.supabase.co.");
    if (!config.key || config.key.length < 10) throw new Error("Enter the public anon or publishable key for this Supabase project.");
    state.config = config;
    saveLocal();
    setSyncState("syncing", "Connecting to shared board…");
    connected = false;
    liveChannel?.unsubscribe();
    liveChannel = null;
    activityChannel?.unsubscribe();
    activityChannel = null;
    activityLive = false;
    client = window.supabase.createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
    let resolveRealtime;
    let rejectRealtime;
    const realtimeReady = new Promise((resolve, reject) => { resolveRealtime = resolve; rejectRealtime = reject; });
    const realtimeTimer = setTimeout(() => rejectRealtime(new Error("Realtime did not connect. Check that cell_spacer_cells is in the Supabase Realtime publication.")), 12000);
    liveChannel = client.channel("cell-spacer-live-board", { config: { presence: { key: deviceId } } })
      .on("presence", { event: "sync" }, renderPresence)
      .on("presence", { event: "join" }, renderPresence)
      .on("presence", { event: "leave" }, renderPresence)
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, (payload) => {
        const row = payload.new;
        if (!row?.id) return;
        const localTime = state.cellTimestamps[row.id] ? Date.parse(state.cellTimestamps[row.id]) : 0;
        const remoteTime = Date.parse(row.updated_at || "1970-01-01T00:00:00Z");
        if (remoteTime <= localTime) return;
        const applied = readRemoteIntoLocal(row);
        if (!applied) return;
        state.cellTimestamps[row.id] = row.updated_at;
        saveLocal();
        if (applied.shift.id === state.currentId) render();
      }).subscribe((status) => {
      if (status === "SUBSCRIBED") {
        resolveRealtime();
        if (connected) trackDevicePresence();
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") rejectRealtime(new Error("Realtime could not subscribe. Check the Supabase Realtime publication and table permissions."));
    });
    try {
      await realtimeReady;
    } finally {
      clearTimeout(realtimeTimer);
    }
    connected = true;
    trackDevicePresence();
    renderPresence();
    let metadataRows;
    let activeRows;
    try {
      [metadataRows, activeRows] = await Promise.all([fetchShiftMetadata(), fetchShiftCells(state.currentId)]);
    } catch (error) {
      throw new Error(error.message.includes("does not exist") ? "The shared board table is missing. Run supabase-schema.sql in your project's SQL editor first." : error.message);
    }
    const remoteMetadata = mergeRemoteRows(metadataRows || []);
    mergeRemoteRows(activeRows || []);
    const activeId = state.currentId;
    state.loadedShifts[activeId] = true;
    sessionLoadedShiftIds.add(activeId);
    const pendingMetadata = [];
    for (const shift of Object.values(state.shifts)) {
      seedLocalTimestamps(shift);
      if (shift.id === activeId) continue;
      const key = cellId(shift);
      const existing = remoteMetadata.get(key);
      const localTime = Date.parse(state.cellTimestamps[key] || "1970-01-01T00:00:00Z");
      const remoteTime = existing ? Date.parse(existing.updated_at || "1970-01-01T00:00:00Z") : 0;
      if (!existing || localTime > remoteTime) pendingMetadata.push({ id: key, value: cellValue(shift, key), updated_at: state.cellTimestamps[key] });
    }
    saveLocal();
    if (pendingMetadata.length) {
      const { error: pushError } = await client.from(TABLE).upsert(pendingMetadata, { onConflict: "id" });
      if (pushError) throw new Error(pushError.message);
    }
    await syncLocalShiftCells(state.shifts[activeId], activeRows || []);
    setSyncState("online", "Live · all devices");
    el("shareButton").hidden = false;
    render();
    flushPendingActivity();
    if (activitySidebarOpen) {
      startActivityRealtime();
      loadActivityPage(true);
    }
    return { shifts: metadataRows?.length || 0, currentCells: activeRows?.length || 0 };
  }

  function configFromHash() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const url = hash.get("supabase");
    const key = hash.get("key");
    return url && key ? { url, key } : null;
  }

  function makeShareLink() {
    const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    return `${base}#supabase=${encodeURIComponent(state.config.url)}&key=${encodeURIComponent(state.config.key)}`;
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(makeShareLink());
      showToast("Live board link copied. Anyone with the link can view and edit counts.");
    } catch (error) {
      showToast(makeShareLink());
    }
  }

  function nextShift() {
    let dateText = activeShift().date;
    let shiftName = activeShift().shift;
    for (let attempts = 0; attempts < 12; attempts += 1) {
      const index = SHIFT_ORDER.indexOf(shiftName);
      if (index < SHIFT_ORDER.length - 1) shiftName = SHIFT_ORDER[index + 1];
      else {
        const date = new Date(`${dateText}T12:00:00`);
        date.setDate(date.getDate() + 1);
        dateText = localDateString(date);
        shiftName = "AM";
      }
      const existing = state.shifts[shiftId(dateText, shiftName)];
      if (!existing || !existing.finalized) {
        chooseShift(dateText, shiftName);
        showToast(existing ? "Opened the saved shift in progress." : "New shift board is ready.");
        return;
      }
    }
    showToast("No new shift slot was found. Choose a date and shift manually.");
  }

  function handleCountInput(input) {
    const shift = activeShift();
    if (!shift || shift.finalized) return;
    const bench = input.dataset.bench;
    const index = Number(input.dataset.hour);
    if (shift.inactive[bench] || shift.hourDisabled[bench][index]) return;
    const raw = input.value;
    if (raw !== "" && !/^\d{1,3}$/.test(raw)) return;
    const count = raw === "" ? null : Number(raw);
    const previous = shift.entries[bench][index] ?? null;
    if (Object.is(previous, count)) return;
    shift.entries[bench][index] = Number.isFinite(count) ? count : null;
    touchCell(shift, cellId(shift, bench, index));
    queueCountActivity(shift, bench, index, previous, Number.isFinite(count) ? count : null);
    refreshSummaries();
  }

  function sanitizeCountInput(input) {
    const raw = input.value;
    if (!/^\d{0,3}$/.test(raw)) {
      const shift = activeShift();
      const count = shift?.entries[input.dataset.bench]?.[Number(input.dataset.hour)];
      input.value = count === null || count === undefined ? "" : String(count);
    }
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csvLine(values) {
    return values.map(csvCell).join(",");
  }

  function shiftHasData(shift) {
    return shift.finalized || Object.values(shift.notes || {}).some((note) => String(note || "").trim()) || VARIABLE_TASKS.some((task) => taskOperatorCount(shift, task) > 0) || FIXED_TASKS.some((task) => !fixedTaskIncluded(shift, task.key)) || BENCHES.some((bench) => shift.inactive[bench] || shift.singleOp[bench]
      || shift.hourDisabled[bench]?.some(Boolean)
      || shift.entries[bench]?.some((count) => count !== null && count !== undefined));
  }

  function exportRowsForShift(shift) {
    const schedule = getSchedule(shift.date, shift.shift);
    const headers = ["Record type", "Production date", "Weekday", "Shift", "Shift team", "Saved", "Product", "Bench", "Operators", "Operator names", "Bench status", "Hours complete", "Required hours", "Shift total"];
    for (let index = 0; index < 8; index += 1) headers.push(`Hour ${index + 1} time`, `Hour ${index + 1} count`, `Hour ${index + 1} target`, `Hour ${index + 1} result`);
    headers.push("Task", "Task operators", "Estimated shift operators", "Task operator names");
    const lines = [csvLine(headers)];
    const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(new Date(`${shift.date}T12:00:00`));
    const base = [shift.date, weekday, shift.shift, shiftTeamName(shift.date, shift.shift), shift.finalized ? "Yes" : "No"];

    for (const bench of BENCHES) {
      const product = bench.startsWith("MLA ") ? "MLA" : "EMA";
      const result = getBenchResult(shift, bench);
      const hours = [];
      for (let index = 0; index < 8; index += 1) {
        const hour = schedule.hours[index];
        if (!hour) {
          hours.push("", "", "", "");
          continue;
        }
        const count = shift.entries[bench][index];
        const off = !!shift.inactive[bench] || !!shift.hourDisabled[bench][index];
        const status = shift.inactive[bench] ? "Off shift" : shift.hourDisabled[bench][index] ? "Disabled" : count === null || count === undefined ? "Missing" : Number(count) >= goalFor(shift, bench, index) ? "On target" : "Under target";
        hours.push(`${timeText(hour.from)}–${timeText(hour.to)}${hour.break ? " (break)" : ""}`, off || count === null || count === undefined ? "" : count, off ? "" : goalFor(shift, bench, index), off ? status : count === null || count === undefined ? "" : status);
      }
      const benchStatus = result.inactive ? "Off shift" : result.complete ? "Complete" : "Incomplete";
      lines.push(csvLine(["Bench", ...base, product, bench, shift.singleOp[bench] ? "1" : "2", shift.notes?.[bench] || "", benchStatus, result.done, result.required, result.complete && !result.inactive ? result.total : "", ...hours, "", "", "", ""]));
    }

    for (const product of PRODUCTS) {
      const benches = BENCHES.filter((bench) => bench.startsWith(`${product} `));
      const totals = schedule.hours.map((hour) => benches.reduce((sum, bench) => shift.inactive[bench] || shift.hourDisabled[bench][hour.index] ? sum : sum + Number(shift.entries[bench][hour.index] || 0), 0));
      const complete = productBenchResult(shift, product);
      const hourlyCells = [];
      for (let index = 0; index < 8; index += 1) {
        const hour = schedule.hours[index];
        hourlyCells.push(hour ? `${timeText(hour.from)}–${timeText(hour.to)}${hour.break ? " (break)" : ""}` : "", hour ? totals[index] : "", "", "");
      }
      lines.push(csvLine(["Product hourly total", ...base, product, ...Array(7).fill(""), ...hourlyCells, ...Array(4).fill("")]));
      lines.push(csvLine(["Product shift total", ...base, product, "", "", "", complete.complete ? "Complete" : "Incomplete", "", "", complete.complete ? complete.total : "", ...Array(32).fill(""), ...Array(4).fill("")]));
    }
    const estimatedOperators = operatorEstimate(shift).total;
    for (const task of [
      { name: "Firewall", key: "firewall", operators: taskOperatorCount(shift, "firewall") },
      { name: "X-ray", key: "xray", operators: taskOperatorCount(shift, "xray") },
      { name: "CS01", key: "cs01", operators: fixedTaskIncluded(shift, "cs01") ? 2 : 0 },
      { name: "CS02", key: "cs02", operators: fixedTaskIncluded(shift, "cs02") ? 1 : 0 },
    ]) {
      lines.push(csvLine(["Task staffing", ...base, "", ...Array(7).fill(""), ...Array(32).fill(""), task.name, task.operators, estimatedOperators, shift.notes?.[`task:${task.key}`] || ""]));
    }
    return lines.join("\r\n");
  }

  function updateTaskOperators(task, value) {
    const shift = activeShift();
    if (!shift || shift.finalized || !VARIABLE_TASKS.includes(task)) return;
    const previous = taskOperatorCount(shift, task);
    const next = normalizeTaskOperatorCount(value);
    if (previous === next) {
      renderTaskStaffing(shift);
      return;
    }
    shift.taskOperators ||= { firewall: 0, xray: 0 };
    shift.taskOperators[task] = next;
    touchCell(shift, cellId(shift));
    const label = task === "xray" ? "X-ray" : "Firewall";
    addActivity(shift, "task_staffing", `${label} operators: ${previous} → ${next}`, { task: label, from: previous, to: next });
    refreshSummaries();
    renderHistory(shift);
  }

  function updateFixedTask(task, included) {
    const shift = activeShift();
    const details = FIXED_TASKS.find((item) => item.key === task);
    if (!shift || shift.finalized || !details) return;
    const previous = fixedTaskIncluded(shift, task);
    if (previous === included) return;
    shift.taskOperators ||= { firewall: 0, xray: 0, cs01: true, cs02: true };
    shift.taskOperators[task] = included;
    touchCell(shift, cellId(shift));
    addActivity(shift, "task_staffing", `${task.toUpperCase()} ${included ? "included in" : "removed from"} shift staffing (${included ? details.operators : 0} operators)`, {
      task: task.toUpperCase(),
      from: previous ? details.operators : 0,
      to: included ? details.operators : 0,
    });
    refreshSummaries();
    renderHistory(shift);
  }

  function updateOperatorNote(input) {
    const shift = activeShift();
    const key = input.dataset.noteKey;
    if (!shift || shift.finalized || !NOTE_KEYS.includes(key)) return;
    const next = input.value.slice(0, 15);
    if (input.value !== next) input.value = next;
    shift.notes ||= {};
    const previous = String(shift.notes[key] || "");
    if (previous === next) return;
    shift.notes[key] = next;
    touchCell(shift, cellId(shift, key, "note"));
  }

  function logOperatorNoteChange(input) {
    const shift = activeShift();
    if (!shift) return;
    const previous = input.dataset.noteBefore;
    const current = String(shift.notes?.[input.dataset.noteKey] || "");
    delete input.dataset.noteBefore;
    if (previous === undefined || previous === current) return;
    const label = input.dataset.noteLabel || input.dataset.noteKey;
    addActivity(shift, "operator_note", `Operator names updated for ${label}`, { item: label });
  }

  function downloadCsv(filename, content) {
    const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportFilename(shifts, all = false) {
    const suffix = localDateString();
    if (all) return `cell-spacer-all-shifts-${suffix}.csv`;
    const shift = shifts[0];
    return `cell-spacer-${shift.date}-${shift.shift.toLowerCase()}.csv`;
  }

  async function exportCurrentShift() {
    const shift = activeShift();
    if (!shift) return;
    if (connected) await loadShiftDetails(shift.id);
    downloadCsv(exportFilename([shift]), exportRowsForShift(shift));
    showToast("Current shift exported as CSV for Excel.");
  }

  async function exportAllShifts() {
    if (connected) {
      const rows = await fetchAllCells();
      mergeRemoteRows(rows);
      for (const shift of Object.values(state.shifts)) {
        state.loadedShifts[shift.id] = true;
        sessionLoadedShiftIds.add(shift.id);
      }
      saveLocal();
      render();
    }
    const shifts = Object.values(state.shifts).filter(shiftHasData).sort((a, b) => a.date.localeCompare(b.date) || SHIFT_ORDER.indexOf(a.shift) - SHIFT_ORDER.indexOf(b.shift));
    if (!shifts.length) {
      showToast("There are no shifts with saved counts to export yet.");
      return;
    }
    const csv = [
      ...exportRowsForShift(shifts[0]).split("\r\n").slice(0, 1),
      ...shifts.flatMap((shift) => exportRowsForShift(shift).split("\r\n").slice(1)),
    ].join("\r\n");
    downloadCsv(exportFilename(shifts, true), csv);
    showToast(`${shifts.length} shift${shifts.length === 1 ? "" : "s"} exported as CSV for Excel.`);
  }

  function closePresence() {
    el("presenceControl").classList.remove("open");
    el("presenceButton").setAttribute("aria-expanded", "false");
  }

  function togglePresence() {
    const control = el("presenceControl");
    const open = control.classList.toggle("open");
    el("presenceButton").setAttribute("aria-expanded", String(open));
  }

  function handleActionClick(event) {
    const stepper = event.target.closest("[data-task-step]");
    if (stepper) {
      const task = stepper.dataset.task;
      updateTaskOperators(task, taskOperatorCount(activeShift(), task) + Number(stepper.dataset.taskStep));
      return;
    }
    const button = event.target.closest('[data-action="hour-off"]');
    if (!button) return;
    const shift = activeShift();
    if (!shift || shift.finalized) return;
    const bench = button.dataset.bench;
    if (shift.inactive[bench]) return;
    const index = Number(button.dataset.hour);
    const wasDisabled = !!shift.hourDisabled[bench][index];
    shift.hourDisabled[bench][index] = !shift.hourDisabled[bench][index];
    touchCell(shift, cellId(shift, bench, index));
    addActivity(shift, "hour_status", `${bench} · Hour ${index + 1} ${wasDisabled ? "returned to totals" : "excluded from totals"}`, { bench, hour: index + 1, wasDisabled, isDisabled: !wasDisabled });
    render();
  }

  function handleStatusChange(input) {
    const shift = activeShift();
    if (!shift || shift.finalized) return;
    const bench = input.dataset.bench;
    const action = input.dataset.action;
    if (action === "single") {
      if (shift.inactive[bench]) return;
      const previous = !!shift.singleOp[bench];
      shift.singleOp[bench] = input.checked;
      touchCell(shift, cellId(shift, bench));
      addActivity(shift, "operator", `${bench} operator target: ${previous ? "1" : "2"} → ${input.checked ? "1" : "2"} for this shift`, { bench, from: previous ? 1 : 2, to: input.checked ? 1 : 2 });
    } else if (action === "inactive") {
      const wasInactive = !!shift.inactive[bench];
      shift.inactive[bench] = input.checked;
      touchCell(shift, cellId(shift, bench));
      addActivity(shift, "bench_status", `${bench} ${input.checked ? "taken out of" : "returned to"} the shift`, { bench, wasInactive, isInactive: input.checked });
    } else return;
    render();
  }

  function setupEvents() {
    dateInput.addEventListener("change", () => chooseShift(dateInput.value || localDateString(), shiftSelect.value));
    shiftSelect.addEventListener("change", () => chooseShift(dateInput.value || localDateString(), shiftSelect.value));
    el("historySelect").addEventListener("change", (event) => {
      const id = event.target.value;
      if (id && state.shifts[id]) {
        const shift = state.shifts[id];
        state.currentId = id;
        saveLocal();
        render();
        if (connected && !sessionLoadedShiftIds.has(id)) {
          showToast(`Loading ${shift.shift} shift details…`);
          loadShiftDetails(id).catch((error) => {
            console.error("Could not load shift details", error);
            showToast("Could not load this shift from the shared board. Check your connection and try again.");
          });
        }
      }
    });
    el("newShiftButton").addEventListener("click", nextShift);
    for (const root of [table, mobileBoard, el("taskStaffing")]) {
      root.addEventListener("focusin", (event) => {
        if (event.target.matches("[data-note-key]")) event.target.dataset.noteBefore = event.target.value;
      });
      root.addEventListener("input", (event) => {
        if (event.target.matches("[data-note-key]")) updateOperatorNote(event.target);
      });
      root.addEventListener("change", (event) => {
        if (event.target.matches("[data-note-key]")) logOperatorNoteChange(event.target);
      });
    }
    table.addEventListener("input", (event) => { if (event.target.matches('[data-action="count"]')) { sanitizeCountInput(event.target); handleCountInput(event.target); } });
    mobileBoard.addEventListener("input", (event) => { if (event.target.matches('[data-action="count"]')) { sanitizeCountInput(event.target); handleCountInput(event.target); } });
    table.addEventListener("change", (event) => {
      if (event.target.matches('[data-action="count"]')) flushCountActivityForInput(event.target);
      else if (event.target.matches('input[type="checkbox"][data-action]')) handleStatusChange(event.target);
    });
    mobileBoard.addEventListener("change", (event) => {
      if (event.target.matches('[data-action="count"]')) flushCountActivityForInput(event.target);
      else if (event.target.matches('input[type="checkbox"][data-action]')) handleStatusChange(event.target);
    });
    table.addEventListener("click", handleActionClick);
    mobileBoard.addEventListener("click", handleActionClick);
    el("taskStaffing").addEventListener("click", handleActionClick);
    el("taskStaffing").addEventListener("change", (event) => {
      if (event.target.matches("[data-task-count]")) updateTaskOperators(event.target.dataset.taskCount, event.target.value);
      else if (event.target.matches("[data-fixed-task]")) updateFixedTask(event.target.dataset.fixedTask, event.target.checked);
    });
    for (const button of document.querySelectorAll(".filter-button")) {
      button.addEventListener("click", () => { activeFilter = button.dataset.filter; applyFilter(); });
    }
    el("finalizeButton").addEventListener("click", () => {
      const shift = activeShift();
      if (!shift) return;
      const wasFinalized = !!shift.finalized;
      if (shift.finalized) {
        if (!window.confirm("Reopen this saved shift? The shift will be editable again.")) return;
        shift.finalized = false;
      } else {
        const progress = shiftProgress(shift);
        if (!progress.complete) return;
        shift.finalized = true;
      }
      touchCell(shift, cellId(shift));
      addActivity(shift, shift.finalized ? "shift_finalized" : "shift_reopened", `${shift.shift} shift ${shift.finalized ? "finalized" : "reopened"}`, { wasFinalized, isFinalized: shift.finalized });
      render();
      showToast(shift.finalized ? "Shift totals saved to history." : "Shift reopened for editing.");
    });
    el("connectButton").addEventListener("click", () => {
      el("supabaseUrl").value = state.config?.url || "";
      el("supabaseKey").value = state.config?.key || "";
      el("connectionError").textContent = "";
      el("connectModal").showModal();
    });
    el("shareButton").addEventListener("click", copyShareLink);
    el("presenceButton").addEventListener("click", togglePresence);
    el("activityButton").addEventListener("click", () => activitySidebarOpen ? closeActivitySidebar() : openActivitySidebar());
    el("activityCloseButton").addEventListener("click", closeActivitySidebar);
    el("activityBackdrop").addEventListener("click", closeActivitySidebar);
    el("activityMoreButton").addEventListener("click", () => loadActivityPage(false));
    el("activityList").addEventListener("click", (event) => {
      const entry = event.target.closest("[data-activity-shift]");
      if (entry) openShiftFromActivity(entry.dataset.activityShift);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        for (const key of [...pendingCountActivity.keys()]) commitCountActivity(key);
      }
    });
    document.addEventListener("click", (event) => {
      if (!el("presenceControl").contains(event.target)) closePresence();
      if (!el("exportWrap").contains(event.target)) {
        el("exportMenu").hidden = true;
        el("exportButton").setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closePresence();
      closeActivitySidebar();
      el("exportMenu").hidden = true;
      el("exportButton").setAttribute("aria-expanded", "false");
    });
    el("exportButton").addEventListener("click", () => {
      const menu = el("exportMenu");
      menu.hidden = !menu.hidden;
      el("exportButton").setAttribute("aria-expanded", String(!menu.hidden));
    });
    el("exportCurrentButton").addEventListener("click", async () => {
      el("exportMenu").hidden = true;
      el("exportButton").setAttribute("aria-expanded", "false");
      try {
        await exportCurrentShift();
      } catch (error) {
        console.error("Could not export current shift", error);
        showToast("Could not load or export this shift. Check your connection and try again.");
      }
    });
    el("exportAllButton").addEventListener("click", async () => {
      el("exportMenu").hidden = true;
      el("exportButton").setAttribute("aria-expanded", "false");
      try {
        await exportAllShifts();
      } catch (error) {
        console.error("Could not export shifts", error);
        showToast("Could not load or export shift history. Check your connection and try again.");
      }
    });
    el("saveConnectionButton").addEventListener("click", async () => {
      const error = el("connectionError");
      error.textContent = "";
      const config = { url: el("supabaseUrl").value.trim().replace(/\/$/, ""), key: el("supabaseKey").value.trim() };
      el("saveConnectionButton").disabled = true;
      el("saveConnectionButton").textContent = "Connecting…";
      try {
        await connectToCloud(config);
        el("connectModal").close();
        showToast("Shared board connected. Use Share to copy the live link.");
      } catch (connectionError) {
        stopCloudConnection();
        error.textContent = connectionError.message || "Could not connect to this Supabase project.";
        setSyncState("error", "Could not connect");
      } finally {
        el("saveConnectionButton").disabled = false;
        el("saveConnectionButton").textContent = "Connect board";
      }
    });
    el("disconnectButton").addEventListener("click", () => {
      stopCloudConnection();
      state.config = null;
      saveLocal();
      el("shareButton").hidden = true;
      setSyncState("local", "Saved on this device");
      el("connectModal").close();
      showToast("This device will save changes locally.");
    });
  }

  async function start() {
    setupEvents();
    refreshDeviceLabel();
    const linkedConfig = configFromHash();
    const config = linkedConfig || state.config;
    const today = localDateString();
    const initialShift = shiftForNow(today);
    if (!state.currentId || !state.shifts[state.currentId]) {
      const shift = ensureShift(today, initialShift);
      state.currentId = shift.id;
    }
    render();
    saveLocal();
    if (config) {
      el("shareButton").hidden = true;
      try {
        await connectToCloud(config);
      } catch (error) {
        stopCloudConnection();
        console.error("Could not connect to the shared board", error);
        setSyncState("error", "Shared board offline · tap to reconnect");
      }
    }
  }

  start();
})();
