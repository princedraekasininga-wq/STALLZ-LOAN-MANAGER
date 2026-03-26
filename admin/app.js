/**
 * ============================================================================
 * STALLZ LOANS MANAGER - APP.JS
 * v2.0 | All Fixes: Syntax Cleanup & Stability
 * ============================================================================
 */

/* ============================================================================
 * 1.0 | APP CONFIGURATION & CONSTANTS
 * ============================================================================ */

const APP_VERSION = (window.STALLZ_APP_VERSION || "0");
const OFFLINE_TEST_MODE = (new URLSearchParams(location.search).get("test") === "1") || (localStorage.getItem("stallz_force_test_mode") === "true");

// Prevent feedback loop when reacting to shared RTDB updates
let __suppressSharedSync = false;

// Planning & Interest Constants
const INTEREST_BY_PLAN = {
  "Weekly": 0.20,
  "2 Weeks": 0.30,
  "Two Weeks": 0.30,
  "3 Weeks": 0.35,
  "Three Weeks": 0.35,
  "Monthly": 0.40
};

const DAYS_BY_PLAN = {
  "Weekly": 7,
  "2 Weeks": 14,
  "Two Weeks": 14,
  "3 Weeks": 21,
  "Three Weeks": 21,
  "Monthly": 0
};
// Wizard Configuration
const LOAN_STEPS = [
  { key: "clientName", label: "Client Name", icon: "👤", type: "text", placeholder: "e.g. John Banda", required: true, helper: "Who is taking the loan?" },
  { key: "clientPhone", label: "Client Phone", icon: "📱", type: "text", placeholder: "e.g. 097...", required: false, helper: "Optional but useful for follow-up." },
  { key: "collateralItem", label: "Collateral Item", icon: "🎒", type: "text", placeholder: "e.g. Samsung A24, HP Laptop", required: true, helper: "What item are they leaving with you?" },
  { key: "collateralValue", label: "Collateral Value", icon: "💰", type: "number", placeholder: "Resale value (e.g. 3000)", required: false, helper: "How much can you realistically sell it for?" },
  { key: "amount", label: "Loan Amount", icon: "💵", type: "number", placeholder: "How much are you giving? (e.g. 1000)", required: true, helper: "Remember: short loans, strong profit, low risk." },
  { key: "plan", label: "Plan", icon: "🕒", type: "select", options: ["Weekly", "2 Weeks", "3 Weeks", "Monthly"], required: true, helper: "Pick the repayment period." },
  { key: "customInterest", label: "Negotiated Interest % (Optional)", icon: "🤝", type: "number", placeholder: "e.g. 15 (Leave empty for standard)", required: false, helper: "Enter a number to override the standard plan rate." },
  { key: "startDate", label: "Start Date", icon: "📅", type: "date", required: true, helper: "The date you give out the money." },
  { key: "notes", label: "Notes (optional)", icon: "📝", type: "textarea", placeholder: "ID, condition, extra details...", required: false, helper: "Extra info for this loan." }
];

const _modalTimers = {}; // Tracks active close timers

/* ============================================================================
 * 2.0 | FIREBASE SETUP & PERSISTENCE
 * ============================================================================ */

// Safety Flag
let isSafeToSave = true;

let db, dataRef;
let _remoteCache = null;

try {
  if (typeof firebase !== "undefined") {
    if (!firebase.apps || !firebase.apps.length) {
      try { window.STALLZ_FIREBASE?.init?.(); } catch(e) {}
    }
    try { firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch(e) {}
    db = firebase.database();
    dataRef = db.ref("loanManagerData_v5");
  } else {
    console.warn("Firebase SDK not loaded. Offline mode only.");
  }
} catch (e) {
  console.error("Firebase Init Error:", e);
}

/* ============================================================================
 * 3.0 | GLOBAL STATE MANAGEMENT
 * ============================================================================ */

const state = {
  dataLoaded: false,
  loans: [],
  nextId: 1,
  startingCapital: 0,
  startingCapitalSetDate: null,
  capitalTxns: [],
  capital: [],
  nextCapitalTxnId: 1,
  repayments: [],
  nextRepaymentId: 1,
  admins: [],
  nextAdminId: 1,
  user: null,
  isLoggedIn: false,
  currentUserProfile: null,
  loanHistoryFilter: "PAST",
  loanHistorySearch: ""
};

// Global Variables
let currentClientView = 'active';
let clientSearchQuery = '';

// Wizard State
let wizardStep = 0;
let wizardDraft = {};
// Filter State
let activeFilters = { status: 'ACTIVE', plan: 'All' };

// Action Modal State
const ACTION = { NONE: "NONE", PAY: "PAY", NOTE: "NOTE", WRITEOFF: "WRITEOFF" };
let currentAction = ACTION.NONE;
let currentLoanId = null;

// --- ADMIN DIALOG (PROMPT/CONFIRM) ---
let __adminDialogCallback = null;

window.showAdminDialog = function(options) {
    const modal = document.getElementById('adminDialogModal');
    if(!modal) return;

    document.getElementById('adminDialogTitle').textContent = options.title || 'Confirm';
    document.getElementById('adminDialogMessage').textContent = options.message || '';

    const inputEl = document.getElementById('adminDialogInput');
    if (options.isPrompt) {
        inputEl.style.display = 'block';
        inputEl.value = '';
        inputEl.placeholder = options.placeholder || '';
        setTimeout(() => inputEl.focus(), 100);
    } else {
        inputEl.style.display = 'none';
    }

    const btn = document.getElementById('adminDialogConfirmBtn');
    btn.className = 'btn ' + (options.btnClass || 'btn-primary');
    btn.textContent = options.btnText || 'Confirm';

    __adminDialogCallback = options.onConfirm;

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.remove('modal-hidden'), 10);
};

window.closeAdminDialog = function() {
    const modal = document.getElementById('adminDialogModal');
    if(modal) {
        modal.classList.add('modal-hidden');
        setTimeout(() => modal.style.display = 'none', 300);
    }
    __adminDialogCallback = null;
};

document.getElementById('adminDialogConfirmBtn')?.addEventListener('click', () => {
    const inputEl = document.getElementById('adminDialogInput');
    const val = inputEl.style.display === 'block' ? inputEl.value : null;

    if (inputEl.style.display === 'block' && !String(val).trim()) {
        showToast("This field is required", "error");
        if(typeof vibrate === "function") vibrate([50]);
        return;
    }

    closeAdminDialog();
    if (__adminDialogCallback) __adminDialogCallback(val);
});

/* ============================================================================
 * 4.0 | UTILITIES & HELPER FUNCTIONS
 * ============================================================================ */

function el(id) { return document.getElementById(id); }

window.forceHideLoader = function() {
  const loader = el("loadingOverlay");
  try { const em = localStorage.getItem("stallz_last_email"); if (em && el("loginEmail") && !el("loginEmail").value) el("loginEmail").value = em; } catch(e) {}
  if (loader) loader.style.display = "none";
}

function formatMoney(amount) {
  if (amount === undefined || amount === null || isNaN(amount)) return "K0.00";
  return "K" + Number(amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

const DATE_FMT = new Intl.DateTimeFormat("en-ZM", { year: "2-digit", month: "short", day: "numeric" });

function escapeHTML(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseDateSmart(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function toDateOnly(dt) {
  if (!dt) return "";
  const d = new Date(dt.getTime());
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addMonthsSafe(dt, months) {
  const d = new Date(dt.getTime());
  d.setHours(0, 0, 0, 0);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  const d = parseDateSmart(dateStr);
  if (!d) return "-";
  return DATE_FMT.format(d);
}

function getLocalDateVal() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthKey(dateStr) {
  const d = parseDateSmart(dateStr);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function formatWhatsApp(phone) {
  if (!phone) return "";
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '260' + p.substring(1);
  if (p.length === 9) p = '260' + p;
  return p;
}

function getInitials(name) {
  if (!name) return "??";
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
}

/* admin/app.js */

function checkAppVersion() {
  // DISABLED: This check is now handled exclusively by shared/firebase-init.js
  // This prevents the "constant toast notification" loop.
  return;
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function showToast(message, type = "success") {
  const container = el("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type || "success"}`;
  toast.textContent = String(message ?? "");
  container.appendChild(toast);

  // Subtle feedback (only vibrate on error)
  if (type === "error" && typeof vibrate === "function") vibrate([20]);

  const ttl = (type === "error") ? 2600 : 1800;

  setTimeout(() => {
    toast.style.animation = "toastFadeOut 0.35s forwards";
    setTimeout(() => toast.remove(), 360);
  }, ttl);
}

function vibrate(pattern = [15]) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

function animateValue(obj, start, end, duration) {
  if (!obj) return;
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    const value = Math.floor(progress * (end - start) + start);
    obj.innerHTML = "K" + value.toLocaleString();
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      obj.innerHTML = formatMoney(end);
    }
  };
  window.requestAnimationFrame(step);
}

function checkTimeBasedTheme() {
  const toggle = document.getElementById("themeToggle");
  const stored = localStorage.getItem("stallz_theme_preference");

  if (stored) {
    if (stored === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      if (toggle) toggle.checked = false;
    } else {
      document.documentElement.removeAttribute("data-theme");
      if (toggle) toggle.checked = true;
    }
    return;
  }
  const hour = new Date().getHours();
  const isDayTime = hour >= 6 && hour < 18;
  if (isDayTime) {
    document.documentElement.setAttribute("data-theme", "light");
    if (toggle) toggle.checked = false;
  } else {
    document.documentElement.removeAttribute("data-theme");
    if (toggle) toggle.checked = true;
  }
}

let __lastActivityWrite = 0;
function updateSessionActivity() {
  const now = Date.now();
  if (now - __lastActivityWrite < 15000) return;
  __lastActivityWrite = now;
  try { localStorage.setItem("stallz_last_active", now); } catch (e) {}
}
document.addEventListener("click", updateSessionActivity);
document.addEventListener("keydown", updateSessionActivity);
document.addEventListener("touchstart", updateSessionActivity);

/* ============================================================================
 * 5.0 | BUSINESS LOGIC & DATA PROCESSING
 * ============================================================================ */

function computeDerivedFields(loan, today) {
  if (!today) {
    today = new Date();
    today.setHours(0, 0, 0, 0);
  }

  let rate = INTEREST_BY_PLAN[loan.plan] || 0;
  if (loan.customInterest !== undefined && loan.customInterest !== null) {
    rate = Number(loan.customInterest) / 100;
  }

  const startDate = loan.startDate ? (parseDateSmart(loan.startDate) || today) : today;

  let dueDate;
  if (loan.dueDate && typeof loan.dueDate === 'string') {
    dueDate = parseDateSmart(loan.dueDate);
  } else {
    dueDate = new Date(startDate.getTime());
    dueDate.setHours(0, 0, 0, 0);

    if (loan.plan === "Monthly") {
      dueDate = addMonthsSafe(dueDate, 1);
    } else {
      const days = DAYS_BY_PLAN[loan.plan] || 0;
      if (days > 0) dueDate.setDate(dueDate.getDate() + days);
    }
  }

  const totalDue = Number(((loan.amount || 0) * (1 + rate)).toFixed(2));
  const paid = Number(loan.paid || 0);
  const sale = Number(loan.saleAmount || 0);
  const totalIn = paid + sale;
  const balance = Number((totalDue - totalIn).toFixed(2));

  loan.profitCollected = Math.max(0, totalIn - (loan.amount || 0));

  let status = "ACTIVE";
  if (balance <= 0.01) {
    status = "PAID";
  } else if (loan.isDefaulted) {
    status = "DEFAULTED";
  } else if (dueDate && today.getTime() > dueDate.getTime()) {
    status = "OVERDUE";
  }

  const daysOverdue = (dueDate && today.getTime() > dueDate.getTime() && status !== "PAID")
    ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  loan.rate = rate;
  loan.dueDate = toDateOnly(dueDate);
  loan.totalDue = totalDue;
  loan.balance = balance;
  loan.status = status;
  loan.daysOverdue = daysOverdue;
}

function recomputeAllLoans() {
  if (!state.loans) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  state.loans.forEach(loan => computeDerivedFields(loan, today));
}

/* Fix ID Collision Risk */
function generateLoanId() {
    // Timestamp + Random Number to prevent collisions
    return Date.now() + Math.floor(Math.random() * 1000);
}

// FIX: Use Timestamp + Random to prevent collision if multiple admins save at exact same ms
function generateRepaymentId() {
    return Date.now() + Math.floor(Math.random() * 100);
}

function generateCapitalTxnId() {
    return Date.now() + Math.floor(Math.random() * 100);
}
// Database Sync Logic
function loadFromFirebase() {
  if (typeof initializeMissingNodes === "function") {
    initializeMissingNodes();
  }

  setTimeout(() => {
    const loader = document.getElementById("loadingOverlay");
    if (loader && loader.style.display !== "none") {
      console.warn("Database connection slow. Forcing UI open in offline/cached mode.");
      loader.style.display = "none";
      if (!state.dataLoaded) {
        applyData({ loans: [], nextId: 1, admins: [] });
      }
    }
  }, 3000);

  if (typeof OFFLINE_TEST_MODE !== "undefined" && OFFLINE_TEST_MODE) {
    setTimeout(() => {
      try {
        const localData = localStorage.getItem("stallz_test_data");
        let parsed = localData ? JSON.parse(localData) : null;
        if (!parsed) {
          parsed = {
            loans: [],
            nextId: 1,
            admins: [{ id: 1, name: "Test Owner", email: "test@admin.com", role: "Owner" }]
          };
        }
        applyData(parsed);
      } catch (e) {
        applyData({ loans: [], nextId: 1, admins: [] });
      }
    }, 500);
    return;
  }

  if (!dataRef) {
    applyData({});
    return;
  }

  dataRef.on("value", (snapshot) => {
    if(typeof isSafeToSave !== 'undefined') isSafeToSave = true;
    const val = snapshot.val() || {};
    if(typeof _remoteCache !== 'undefined') _remoteCache = val;
    applyData(val);
  }, (error) => {
    console.error("Firebase read failed:", error);
  });

  setInterval(() => {
    if(document.visibilityState === 'visible') {
        dataRef.get().then(s => applyData(s.val()||{})).catch(e=>{});
    }
  }, 60000);
}

function applyData(parsed) {
  const loader = document.getElementById("loadingOverlay");
  if (loader) loader.style.display = "none";

  state.dataLoaded = true;

  // Track the current RTDB container shape for loans (array vs object)
  try {
    state.__loansContainerType = Array.isArray(parsed?.loans) ? 'array' : (parsed?.loans && typeof parsed.loans === 'object' ? 'object' : 'array');
  } catch(e) { state.__loansContainerType = 'array'; }

  // 1. Parse Loans (Preserve RTDB key path + de-duplicate by loan.id)
  const rawLoans = [];
  try {
    const src = parsed.loans;
    if (Array.isArray(src)) {
      src.forEach((v, idx) => {
        if (v && typeof v === "object") rawLoans.push(Object.assign({}, v, { __loanPath: `loans/${idx}` }));
      });
    } else if (src && typeof src === "object") {
      Object.entries(src).forEach(([k, v]) => {
        if (v && typeof v === "object") rawLoans.push(Object.assign({}, v, { __loanPath: `loans/${k}` }));
      });
    }
  } catch (e) {}

  // Group by loan.id and keep the most recently updated copy
  const byId = new Map();
  rawLoans.forEach((l) => {
    const idKey = (l && l.id !== undefined && l.id !== null) ? String(l.id) : String(l.__loanPath);
    const existing = byId.get(idKey);
    const t = Date.parse(l.updatedAt || l.createdAt || "");
    const ts = isNaN(t) ? 0 : t;

    if (!existing) {
      byId.set(idKey, { loan: l, paths: [l.__loanPath], ts });
    } else {
      existing.paths.push(l.__loanPath);

      // Prefer "full" records over accidental thin duplicates
      const isThinLoan = (ln) => {
        if (!ln || typeof ln !== "object") return true;
        const has = (v) => v !== undefined && v !== null && v !== "";
        const hasCore = (
          has(ln.amount) ||
          has(ln.totalDue) ||
          has(ln.totalPayable) ||
          has(ln.plan) ||
          has(ln.startDate) ||
          has(ln.dueDate)
        );
        return !hasCore;
      };

      const prevLoan = existing.loan;
      const prevThin = isThinLoan(prevLoan);
      const candThin = isThinLoan(l);

      const chooseCandidate = () => { existing.loan = l; existing.ts = ts; };

      if (prevThin && !candThin) {
        chooseCandidate();
      } else if (!prevThin && candThin) {
        // keep the richer previous record
      } else if (ts > existing.ts) {
        chooseCandidate();
      } else if (ts === existing.ts) {
        const getPaid = (ln) => Number(ln?.paid || 0) + Number(ln?.saleAmount || 0);
        const getTotal = (ln) => Number(ln?.totalDue || ln?.totalPayable || 0);

        const prevPaid = getPaid(prevLoan);
        const candPaid = getPaid(l);
        const prevTotal = getTotal(prevLoan);
        const candTotal = getTotal(l);

        const prevIsPaid = String(prevLoan?.status || "").toUpperCase() === "PAID" || (prevTotal > 0 && prevPaid >= (prevTotal - 0.01));
        const candIsPaid = String(l?.status || "").toUpperCase() === "PAID" || (candTotal > 0 && candPaid >= (candTotal - 0.01));

        if (candIsPaid && !prevIsPaid) {
          chooseCandidate();
        } else if (!candIsPaid && prevIsPaid) {
          // keep prev
        } else {
          const prevRatio = prevTotal > 0 ? (prevPaid / prevTotal) : prevPaid;
          const candRatio = candTotal > 0 ? (candPaid / candTotal) : candPaid;

          if (candRatio > prevRatio) {
            chooseCandidate();
          } else if (candRatio === prevRatio) {
            if (Object.keys(l || {}).length > Object.keys(prevLoan || {}).length) {
              chooseCandidate();
            }
          }
        }
      }
    }
  });

  state.loans = Array.from(byId.values()).map((entry) => {
    const winner = entry.loan || {};
    winner.__loanPaths = (entry.paths || []).filter(Boolean);
    winner.__primaryLoanPath = winner.__loanPath || winner.__loanPaths[0] || null;
    return winner;
  });

  // Sort newest first (fallback 0 when id is missing)
  state.loans.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));

  // =========================================================================
  // 🧹 AUTO-FIX: Schedule cleanup of "Thin" duplicates if any exist
  // =========================================================================
  if (!OFFLINE_TEST_MODE && dataRef) {
      const pathsToDelete = {};
      let cleanupCount = 0;

      state.loans.forEach(l => {
          if (l.__loanPaths && l.__loanPaths.length > 1) {
              // Keep the primary, delete the rest
              l.__loanPaths.forEach(path => {
                  if (path !== l.__primaryLoanPath) {
                      pathsToDelete[path] = null; // Prepare delete
                      cleanupCount++;
                  }
              });
              // Reset local paths so we don't try to delete again
              l.__loanPaths = [l.__primaryLoanPath];
          }
      });

      if (cleanupCount > 0) {
          console.log(`🧹 Cleaning up ${cleanupCount} duplicate loan records...`);
          // Run quietly in background
          dataRef.update(pathsToDelete).catch(e => console.warn("Cleanup warning:", e));
      }
  }
  // =========================================================================

  // 2. Parse Capital History
  if (parsed.capitalTxns && typeof parsed.capitalTxns === 'object') {
      state.capitalTxns = Object.values(parsed.capitalTxns);
  } else {
      state.capitalTxns = parsed.capitalTxns || [];
  }

  // Sort Capital by Newest Date First
  if (state.capitalTxns.length > 0) {
      state.capitalTxns.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  // 🔴 FIXED: Parse Expenses cleanly here (No monkey-patching!)
  state.expenses = parsed.expenses ? Object.values(parsed.expenses).filter(e => e && typeof e === "object") : [];

  // 3. Load Other Data Variables
  state.nextId = parsed.nextId || 1;
  state.startingCapital = Number(parsed.startingCapital || 0);
  state.startingCapitalSetDate = parsed.startingCapitalSetDate || null;
  state.nextCapitalTxnId = parsed.nextCapitalTxnId || 1;

  state.capital = parsed.capital || []; // Legacy support

  // Robust Repayments Parsing
  if (parsed.repayments && typeof parsed.repayments === 'object') {
      state.repayments = Object.values(parsed.repayments).filter(r => r && typeof r === "object");
  } else {
      state.repayments = (parsed.repayments || []).filter?.(r => r && typeof r === "object") || (parsed.repayments || []);
  }
  // Sort newest first
  if (state.repayments.length > 1) {
      state.repayments.sort((a, b) => Date.parse(b.createdAt || b.date || "") - Date.parse(a.createdAt || a.date || ""));
  }
  state.nextRepaymentId = parsed.nextRepaymentId || 1;

  state.admins = parsed.admins || [];
  state.nextAdminId = parsed.nextAdminId || 1;

  // 4. Refresh UI & Perform Critical Sync
  try {
    refreshUI();
    updateWelcomeUI();

    if (state.loans && state.loans.length > 0) {
        const force = !state.__initialClientSyncDone;
        distributeLoansToClients(state.loans, force);
        state.__initialClientSyncDone = true;
    }

    try { window.StallzShared?.ensureSeed?.(); } catch(e) {}
    try { window.StallzShared?.syncAdminSnapshot?.(state.loans || []); } catch(e) {}

  } catch (e) {
    console.error("Render error:", e);
  }
}
async function initializeMissingNodes() {
  if (OFFLINE_TEST_MODE || !dataRef) return;
  try {
    await dataRef.transaction((currentData) => {
      if (currentData === null) {
        return {
          loans: [],
          nextId: 1,
          startingCapital: 0,
          startingCapitalSetDate: null,
          capitalTxns: [],
          nextCapitalTxnId: 1,
          repayments: [],
          nextRepaymentId: 1,
          admins: [],
          nextAdminId: 1,
          lastWrite: firebase.database.ServerValue.TIMESTAMP
        };
      }
      return;
    });
    // NOTE: Your RTDB rules set /stallzShared_v1 root to .read:false, so root-level transactions will fail.
    // We only "touch" a readable/writable child to avoid permission spam.
    const adminNotifsRef = firebase.database().ref("stallzShared_v1/notifications/admin");
    try {
      const s = await adminNotifsRef.get();
      if (!s.exists()) await adminNotifsRef.set({});
    } catch(e) {
      // If rules block this path, ignore — the app can still function without seeding.
    }
  } catch (error) {
    console.error("Auto-init failed:", error);
  }
}


async function saveState() {
  // 1. Safety Check: Only proceed if data is loaded
  if (!state.dataLoaded) return;

  // 2. THE FIX: Only run full state saves in Offline Test Mode.
  // This prevents cloud-connected admins from accidentally overwriting each other's changes.
  if (OFFLINE_TEST_MODE) {
    const payload = {
      loans: state.loans || [],
      nextId: state.nextId || 1, // Legacy counter (loans use timestamps now)
      startingCapital: state.startingCapital || 0,
      startingCapitalSetDate: state.startingCapitalSetDate || null,
      capitalTxns: state.capitalTxns || [],
      nextCapitalTxnId: state.nextCapitalTxnId || 1,
      repayments: state.repayments || [],
      nextRepaymentId: state.nextRepaymentId || 1,
      admins: state.admins || [],
      nextAdminId: state.nextAdminId || 1,
      lastWrite: new Date().toISOString()
    };

    localStorage.setItem("stallz_test_data", JSON.stringify(payload));

    if (window.StallzShared?.syncAdminSnapshot) {
       window.StallzShared.syncAdminSnapshot(state.loans);
    }

    showToast("Saved locally (Test Mode)", "success");
    return;
  }

  // 3. Cloud Mode Protection
  // Cloud writes are now handled by Atomic Updates in saveNewLoan() and the Action Modal.
  if (!dataRef) {
    showToast("Database Disconnected", "error");
    return;
  }

  console.warn("Full saveState blocked in Cloud Mode to prevent data loss. Use atomic updates.");
}
/* ============================================================================
 * AUTH GATE & UI
 * ============================================================================ */
// Send a custom push alert directly to a client's phone/PC
async function sendCustomAlertToClient(clientUid, title, message) {
    try {
        const notifId = "n_" + Date.now();
        const payload = {
            id: notifId,
            title: title,
            body: message,
            read: false,
            createdAt: new Date().toISOString(),
            type: "CUSTOM_ALERT"
        };

        // THE FIX: Save it inside the authorized 'clients' node!
        await firebase.database().ref(`clients/${clientUid}/notifications/${notifId}`).set(payload);
        showToast("Alert sent to client's device!", "success");

    } catch (error) {
        console.error("Failed to send alert:", error);
        showToast("Failed to send alert", "error");
    }
}

async function ensureAdminAccess() {
  const gate = document.getElementById("authGate");
  if (gate) gate.style.display = "flex";

  if (typeof OFFLINE_TEST_MODE !== 'undefined' && OFFLINE_TEST_MODE) {
    state.user = { email: "offline@stallz.local", uid: "offline-admin" };
    state.isLoggedIn = true;
    state.currentUserProfile = { name: "OFFLINE ADMIN", role: "TESTER" };
    if (gate) gate.style.display = "none";
    loadFromFirebase();
    updateWelcomeUI();
    return true;
  }

  try {
    const user = await window.StallzAuth?.onceAuthState?.();
    if (!user) {
      window.location.replace("../index.html");
      return false;
    }

    // NEW: Explicitly fetch and wait for profile BEFORE clearing the loading gate
    // This ensures "Hi, Admin" doesn't flicker before the real name appears
    let foundProfile = null;
    try {
      const rootSnap = await firebase.database().ref(`admins/${user.uid}`).get();
      if (rootSnap.exists()) {
        foundProfile = rootSnap.val();
      }
    } catch(e) {
      console.log("Root admin check failed, trying database list...");
    }

    if (!foundProfile) {
        const snap = await dataRef.child("admins").get();
        const adminsList = snap.val() || [];
        const listArray = Array.isArray(adminsList) ? adminsList : Object.values(adminsList);
        foundProfile = listArray.find(admin =>
          admin.email && admin.email.toLowerCase() === user.email.toLowerCase()
        );
    }

    if (!foundProfile) {
      console.warn("User not authorized as Admin.");
      await window.StallzAuth?.signOut?.();
      window.location.replace("../index.html");
      return false;
    }

    // Set state and update UI immediately
    state.user = user;
    state.isLoggedIn = true;
    state.currentUserProfile = foundProfile;
    updateWelcomeUI();

    if (gate) gate.style.display = "none";

    loadFromFirebase();
    return true;

  } catch(e) {
    console.error("Auth Check Failed:", e);
    if (window.location.pathname.includes("admin.html")) {
        window.location.replace("../index.html");
    }
    return false;
  }
}

function updateWelcomeUI() {
  if (!state.currentUserProfile && !state.user && !localStorage.getItem('stallz_offline_name')) return;

  let profile = state.currentUserProfile;

  if (!profile && state.admins && state.user) {
     const email = state.user.email.toLowerCase();
     profile = state.admins.find(a => a.email && a.email.toLowerCase() === email);
  }

  let firstName = "ADMIN";
  let fullName = "STALLZ ADMIN";
  let role = localStorage.getItem('stallz_offline_role') === 'admin' ? "OWNER" : "USER";

  // 1. Restore the cached name if offline/missing (Stops the "Hi, Admin" glitch!)
  const cachedName = localStorage.getItem('stallz_offline_name');
  if (cachedName) {
      fullName = cachedName.toUpperCase();
      firstName = fullName.split(' ')[0];
  }

  // 2. Overwrite with live Firebase data if available
  if (profile && profile.name) {
    fullName = profile.name.toUpperCase();
    firstName = fullName.split(' ')[0];
  } else if (profile && profile.firstname) {
     firstName = profile.firstname.toUpperCase();
     fullName = (profile.firstname + " " + (profile.surname||"")).toUpperCase();
  } else if (state.user && state.user.displayName) {
     fullName = state.user.displayName.toUpperCase();
     firstName = fullName.split(' ')[0];
  } else if (state.user && state.user.email) {
     firstName = state.user.email.split('@')[0].toUpperCase();
     if (!cachedName) fullName = firstName;
  }

  if (profile && profile.role) {
      role = profile.role.toUpperCase();
  }

  // Update Header Name
  const headerEl = document.getElementById("headerUsername");
  if (headerEl) headerEl.textContent = firstName;

  // Set Dynamic Time-Based Greeting
  const greetingEl = document.getElementById("greetingText");
  if (greetingEl) {
      const hour = new Date().getHours();
      if (hour < 12) greetingEl.textContent = "Good Morning";
      else if (hour < 18) greetingEl.textContent = "Good Afternoon";
      else greetingEl.textContent = "Good Evening";
  }

  // Update Sidebar Elements
  const sbName = document.getElementById("sidebarName");
  const sbRole = document.getElementById("sidebarEmail");
  const sbAvatar = document.getElementById("sidebarAvatar");

  if (sbName) sbName.textContent = fullName;
  if (sbRole) sbRole.textContent = role;
  if (sbAvatar) {
    sbAvatar.textContent = fullName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  }
}
/* ============================================================================
 * 7.0 | UI RENDERING (DASHBOARD & TABLES)
 * ============================================================================ */

let __hasAutoLinked = false;

function linkOrphanedLoans() {
  if (__hasAutoLinked || !state.loans || !window.StallzShared) return;

  const users = window.StallzShared.listUsers("client");
  if (!users || users.length === 0) return;

  const updates = {};
  let count = 0;

  state.loans.forEach(l => {
    if (!l.clientUid && l.clientPhone) {
      const cleanLoanPhone = String(l.clientPhone).replace(/\D/g, "").replace(/^0/, "260");

      const match = users.find(u => {
          const cleanUserPhone = String(u.phone).replace(/\D/g, "").replace(/^0/, "260");
          return cleanUserPhone === cleanLoanPhone && cleanUserPhone.length > 9;
      });

      if (match && match.uid) {
        // SECURITY LOG:
        console.warn(`⚠️ SECURITY: Auto-linking Loan #${l.id} (${l.clientName}) to User UID: ${match.uid}`);

        l.clientUid = match.uid;

        // ✅ FIX: write to the *real* RTDB key for this loan (array index vs object key)
        const __paths = (Array.isArray(l.__loanPaths) && l.__loanPaths.length)
          ? l.__loanPaths.slice()
          : (l.__loanPath ? [l.__loanPath] : [`loans/${l.id}`]);
        const __primary = l.__primaryLoanPath || l.__loanPath || __paths[0];

        // Update clientUid everywhere (so whichever copy is displayed later is linked)
        __paths.forEach(p => { if (p) updates[`${p}/clientUid`] = match.uid; });

        // Only bump updatedAt on the primary copy (prevents "thin" duplicates from winning)
        updates[`${__primary}/updatedAt`] = new Date().toISOString();

        count++;
      }
    }
  });

  if (count > 0) {
    if (!OFFLINE_TEST_MODE && dataRef) {
       dataRef.update(updates);
       // Force sync immediately to secure the data
       distributeLoansToClients(state.loans, true);
    }
    showToast(`Linked ${count} loans to registered accounts`, "success");
  }

  __hasAutoLinked = true;
}

/* refreshUI (Final Integration: Smart Notifs + Admin Profiles) */

/* admin/app.js - REPLACE YOUR EXISTING refreshUI FUNCTION WITH THIS */

function refreshUI() {
  try { linkOrphanedLoans(); } catch(e) {}
  try { recomputeAllLoans(); } catch (e) { console.error("Error computing loans:", e); }

  const overdueLoans = (state.loans || []).filter(l => l.status === "OVERDUE");
  const bellBadge = document.getElementById("bellBadge");
  const notifList = document.getElementById("notifList");

  let sharedNotifs = [];
  try {
    window.StallzShared?.ensureSeed?.();
    sharedNotifs = window.StallzShared?.getAdminNotifications?.() || [];
  } catch (e) {
    sharedNotifs = [];
  }

  // ✅ SMART FILTER: Hide "Due Soon" alerts if the loan is effectively paid
  sharedNotifs = sharedNotifs.filter(n => {
    // Check if this is a loan-related alert
    if (n.type === "DUE_SOON" && n.meta && n.meta.loanId) {
      // Find the actual loan in our latest data
      const loan = state.loans.find(l => String(l.id) === String(n.meta.loanId));

      if (loan) {
        // 1. Check Status
        const isClosed = (loan.status === "PAID" || loan.status === "DEFAULTED");
        // 2. Check Balance (Extra safety: if balance is 0 or less, it's paid)
        const isZeroBalance = (Number(loan.balance || 0) <= 0.01);

        // If either is true, this alert is stale -> HIDE IT
        if (isClosed || isZeroBalance) {
          return false;
        }
      }
    }
    // Keep valid alerts
    return true;
  });

  const hasAny = (sharedNotifs.length + overdueLoans.length) > 0;
  if (bellBadge) bellBadge.classList.toggle("show", hasAny);

  if (notifList) {
    if (!hasAny) {
        notifList.innerHTML = `<div style="padding:20px; text-align:center; color:#94a3b8; font-size:0.8rem;">All caught up! No alerts.</div>`;
    } else {
        const sharedHtml = sharedNotifs.map(n => {
        const icon = n.type === "LOAN_REQUEST" ? "📝"
            : n.type === "NEW_CLIENT" ? "🆕"
            : n.type === "MESSAGE" ? "💬"
            : n.type === "DUE_SOON" ? "⏳"
            : "🔔";
        const sub = n.body ? `<div style="opacity:0.7;">${escapeHTML(n.body)}</div>` : "";
        const click = n.type === "LOAN_REQUEST" ? `window.openLoanRequestModal(${Number(n.meta?.requestId) || 0})`
            : n.type === "MESSAGE" ? `window.openAdminMessageModal('${String(n.meta?.clientUid || "")}')`
            : n.type === "NEW_CLIENT" ? `openPopup('clientsModal')`
            : n.type === "DUE_SOON" ? (n.meta?.loanId ? `openActionModal('PAY', ${Number(n.meta.loanId)})` : `openPopup('clientsModal')`)
            : `void 0`;
        return `
            <div class="notif-item" onclick="${click}">
            <span style="margin-right:8px;">${icon}</span>
            <div>
                <div style="font-weight:600;">${escapeHTML(n.title || "Notification")}</div>
                ${sub}
            </div>
            </div>`;
        }).join("");

        const overdueHtml = overdueLoans.map(l => `
            <div class="notif-item" onclick="openActionModal('PAY', ${l.id})">
                <span style="color:#ef4444; margin-right:8px;">⚠️</span>
                <div>
                    <div style="font-weight:600;">Overdue: ${escapeHTML(l.clientName)}</div>
                    <div style="opacity:0.7;">Due: ${formatDate(l.dueDate)} • ${formatMoney(l.balance)}</div>
                </div>
            </div>
        `).join("");

        notifList.innerHTML = sharedHtml + overdueHtml;
    }
  }

  // ✅ SIDEBAR UPDATE: Render Clickable Admin Rows for Profiles
  const tbody = document.getElementById("sidebarAdminsBody");
  if (tbody) {
    tbody.innerHTML = (state.admins || []).map(a => `
        <tr onclick="openAdminProfile('${a.uid || a.email}')" style="cursor:pointer; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
            <td style="font-weight:600; padding:12px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <div class="avatar avatar-${(a.name.length)%5}" style="width:28px; height:28px; font-size:0.75rem;">${getInitials(a.name)}</div>
                    <div>${escapeHTML(a.name)}</div>
                </div>
            </td>
            <td style="font-size:0.75rem; opacity:0.7; text-align:right; padding:12px;">
                <span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px;">${(a.role||"Admin").toUpperCase()}</span>
            </td>
        </tr>`).join("");
  }

  try { renderDashboard(); } catch (e) { console.error("Dash Error:", e); }
  try { renderLoansTable(); } catch (e) { console.error("Loans Table Error:", e); }
  try { renderRepaymentsTable(); } catch (e) { console.error("Repay Table Error:", e); }
  try { renderMonthlyTable(); } catch (e) { console.error("Monthly Table Error:", e); }
  try { renderClientsTable(); } catch (e) { console.error("Clients Table Error:", e); }
  try { renderCapitalHistory(); } catch (e) { console.error("Cap History Error:", e); }
}
// Global flag to prevent re-animating numbers every 15 seconds
let __dashboardAnimRan = false;


/* ==========================================================================
   LOANS HISTORY (Modal)
   ========================================================================== */

function _loanThinScore(ln){
  try {
    if (!ln || typeof ln !== "object") return 0;
    const keys = Object.keys(ln).filter(k => ln[k] !== undefined && ln[k] !== null);
    return keys.length;
  } catch(e){ return 0; }
}

function dedupeLoansById(list){
  const byId = new Map();
  (list || []).forEach((ln) => {
    if (!ln || typeof ln !== "object") return;
    const id = (ln.id !== undefined && ln.id !== null) ? String(ln.id) : "";
    if (!id) return;

    const status = String(ln.status || "ACTIVE").toUpperCase();
    const statusRank = (status === "PAID") ? 4 : (status === "DEFAULTED") ? 3 : (status === "OVERDUE") ? 2 : 1;

    const t = Date.parse(ln.updatedAt || ln.paidAt || ln.startDate || "");
    const ts = isNaN(t) ? 0 : t;

    const thin = _loanThinScore(ln);

    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { ln, statusRank, ts, thin });
      return;
    }

    // Prefer: richer record > higher status rank > newer updatedAt > higher paid
    const prevPaid = Number(prev.ln?.paid || 0);
    const thisPaid = Number(ln.paid || 0);

    const better =
      (thin > prev.thin) ||
      (thin === prev.thin && statusRank > prev.statusRank) ||
      (thin === prev.thin && statusRank === prev.statusRank && ts > prev.ts) ||
      (thin === prev.thin && statusRank === prev.statusRank && ts === prev.ts && thisPaid > prevPaid);

    if (better) byId.set(id, { ln, statusRank, ts, thin });
  });
  return Array.from(byId.values()).map(x => x.ln);
}

function isLoanPast(ln){
  const s = String(ln?.status || "ACTIVE").toUpperCase();
  return (s === "PAID" || s === "DEFAULTED");
}

function _fmtDateShort(d){
  try{
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "--";
    return dt.toLocaleDateString("en-ZM", { day:"2-digit", month:"short", year:"2-digit" });
  } catch(e){ return "--"; }
}

function _fmtMoney(n){
  const v = Number(n || 0);
  return formatMoney(isNaN(v) ? 0 : v);
}

function isModalOpen(id){
  const m = document.getElementById(id);
  if (!m) return false;
  return m.style.display !== "none" && !m.classList.contains("modal-hidden");
}

window.openLoanHistoryModal = function(){
  openPopup("loanHistoryModal");
  // prime search value
  const input = document.getElementById("loanHistorySearchInput");
  if (input) {
    input.value = state.loanHistorySearch || "";
    setTimeout(() => { try { input.focus(); } catch(_){} }, 120);
  }
  renderLoanHistory();
};

window.setLoanHistoryFilter = function(mode, btn){
  state.loanHistoryFilter = String(mode || "PAST").toUpperCase();
  // chip active styling
  try{
    const wrap = btn?.parentElement;
    if (wrap) {
      wrap.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      if (btn) btn.classList.add("active");
    }
  } catch(e){}
  renderLoanHistory();
};

function renderLoanHistory(){
  const tbody = document.getElementById("loanHistoryBody");
  if (!tbody) return;

  // Only render while modal exists; safe to render even when closed
  const listAll = dedupeLoansById(state.loans || []);
  const q = String(state.loanHistorySearch || "").trim().toLowerCase();
  const mode = String(state.loanHistoryFilter || "PAST").toUpperCase();

  let list = listAll;

  if (mode === "PAST") {
    list = list.filter(isLoanPast);
  } else if (mode === "ACTIVE") {
    list = list.filter(l => String(l.status || "ACTIVE").toUpperCase() === "ACTIVE");
  } else if (mode === "OVERDUE") {
    list = list.filter(l => String(l.status || "ACTIVE").toUpperCase() === "OVERDUE");
  } // ALL => no filter

  if (q) {
    list = list.filter(l => {
      const id = String(l.id ?? "");
      const client = String(l.clientName ?? "");
      const phone = String(l.clientPhone ?? "");
      const item = String(l.collateralItem ?? "");
      return (id.toLowerCase().includes(q) ||
              client.toLowerCase().includes(q) ||
              phone.toLowerCase().includes(q) ||
              item.toLowerCase().includes(q));
    });
  }

  // Sort newest first: updatedAt > paidAt > startDate > id
  list.sort((a,b)=>{
    const ta = Date.parse(a.updatedAt || a.paidAt || a.startDate || "") || 0;
    const tb = Date.parse(b.updatedAt || b.paidAt || b.startDate || "") || 0;
    if (tb !== ta) return tb - ta;
    return Number(b.id || 0) - Number(a.id || 0);
  });

  if (!list.length){
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted); font-style:italic;">No loan history records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(l => {
    const status = String(l.status || "ACTIVE").toUpperCase();

    let badgeClass = "active";
    if(status === "PAID") badgeClass = "paid";
    if(status === "OVERDUE") badgeClass = "overdue";
    if(status === "DEFAULTED") badgeClass = "defaulted";

    const statusBadge = `<span class="status-pill status-${badgeClass}" style="padding:4px 10px; font-size:0.7rem; letter-spacing:0.5px; border-radius:6px;">${status === 'DEFAULTED' ? 'CLOSED' : status}</span>`;

    const updated = _fmtDateShort(l.updatedAt || l.paidAt || l.startDate);
    const amount = _fmtMoney(l.amount);
    const total = _fmtMoney(l.totalDue);
    const paid = _fmtMoney(l.paid);
    const bal = _fmtMoney(l.balance);

    const hasNotes = !!l.notes;

    // Beautifully aligned professional layout with the new Note button attached
    return `
      <tr style="border-bottom: 1px solid rgba(150, 150, 150, 0.1); transition: background 0.2s ease;">
        <td style="padding: 14px 10px; font-weight:800; color:var(--text-main); font-family:'Courier New', monospace; font-size:0.85rem;">#${escapeHTML(String(l.id ?? "--"))}</td>

        <td style="padding: 14px 10px;">
          <div style="font-weight:700; color:var(--text-main); font-size:0.9rem;">${escapeHTML(String(l.clientName || "Unknown"))}</div>
          <div style="font-size:.75rem; color:var(--text-muted); font-family:'Courier New', monospace; margin-top:3px;">${escapeHTML(String(l.clientPhone || ""))}</div>
        </td>

        <td style="padding: 14px 10px; color:var(--text-muted); font-size:0.85rem;">${escapeHTML(String(l.collateralItem || "Personal Loan"))}</td>

        <td style="padding: 14px 10px; text-align:right; font-weight:700; white-space:nowrap;">${amount}</td>
        <td style="padding: 14px 10px; text-align:right; color:var(--accent-blue); font-weight:800; white-space:nowrap;">${total}</td>
        <td style="padding: 14px 10px; text-align:right; color:var(--success); font-weight:800; white-space:nowrap;">${paid}</td>
        <td style="padding: 14px 10px; text-align:right; font-weight:800; color:var(--text-main); white-space:nowrap;">${bal}</td>

        <td style="padding: 14px 10px; text-align:center; white-space:nowrap;">${statusBadge}</td>

        <td style="padding: 14px 10px; text-align:right; font-size:.8rem; color:var(--text-muted); white-space:nowrap;">
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
                <span>${updated}</span>
                <button onclick="openActionModal('NOTE', ${l.id})" style="background: ${hasNotes ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255,255,255,0.05)'}; color: ${hasNotes ? '#3b82f6' : 'var(--text-muted)'}; border: 1px solid ${hasNotes ? 'rgba(59, 130, 246, 0.3)' : 'transparent'}; padding: 4px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
                    📝 ${hasNotes ? 'Read Notes' : '+ Note'}
                </button>
            </div>
        </td>
      </tr>
    `;
  }).join("");
}

function renderDashboard() {
  const container = document.getElementById("dashboardStats");
  if (!container) return;

  const loans = state.loans || [];

  // 1. Calculate Stats
  const totalLoaned = loans.reduce((s, l) => s + (l.amount || 0), 0);
  const totalOutstanding = loans.reduce((s, l) => {
    if (l.status === "DEFAULTED") return s;
    return s + Math.max(0, l.balance || 0);
  }, 0);
  const totalProfit = loans.reduce((s, l) => s + (l.profitCollected || 0), 0);
  const activeCount = loans.filter(l => l.status === "ACTIVE" || l.status === "OVERDUE").length;

  const starting = state.startingCapital || 0;
  const added = (state.capitalTxns || []).reduce((s, t) => s + (t.amount || 0), 0);
  const paidIn = loans.reduce((s, l) => s + (l.paid || 0), 0);
  const cashOnHand = starting + added + paidIn - totalLoaned;

  // 2. Update Cash Display
  const cashEl = document.getElementById("cashOnHandValue");
  if (cashEl) {
    cashEl.textContent = formatMoney(cashOnHand);
    if (cashOnHand < 0) cashEl.classList.add("text-danger-glow");
    else cashEl.classList.remove("text-danger-glow");
  }

  // 4. Update Starting Capital Display (Separate Section)
  if (state.startingCapital > 0) {
    if (document.getElementById("startingCapitalSetupRow")) document.getElementById("startingCapitalSetupRow").style.display = "none";
    if (document.getElementById("startingCapitalInfoRow")) {
      document.getElementById("startingCapitalInfoRow").style.display = "block";
      if (document.getElementById("startingCapitalInfoValue")) document.getElementById("startingCapitalInfoValue").textContent = formatMoney(state.startingCapital);
    }
    if (document.getElementById("startingCapitalValue")) document.getElementById("startingCapitalValue").textContent = formatMoney(state.startingCapital);
  } else {
    if (document.getElementById("startingCapitalSetupRow")) document.getElementById("startingCapitalSetupRow").style.display = "block";
    if (document.getElementById("startingCapitalInfoRow")) document.getElementById("startingCapitalInfoRow").style.display = "none";
    if (document.getElementById("startingCapitalValue")) document.getElementById("startingCapitalValue").textContent = "Not set";
  }

  // 5. Render Stat Cards
  container.innerHTML = `
    <div class="stat-card" style="border-color: var(--primary);">
      <div class="stat-label">Active Deals</div>
      <div class="stat-value" style="font-size: 1.8rem;">${activeCount}</div>
      <div class="stat-sub">Clients with open balances</div>
    </div>
    <div class="stat-card stat-purple">
      <div class="stat-label">Total Loaned</div>
      <div class="stat-value" id="statLoaned">${typeof __dashboardAnimRan !== 'undefined' && __dashboardAnimRan ? formatMoney(totalLoaned) : 'K0.00'}</div>
      <div class="stat-sub">Lifetime capital deployed</div>
    </div>
    <div class="stat-card stat-orange">
      <div class="stat-label">Outstanding</div>
      <div class="stat-value" id="statOutstanding">${typeof __dashboardAnimRan !== 'undefined' && __dashboardAnimRan ? formatMoney(totalOutstanding) : 'K0.00'}</div>
      <div class="stat-sub">Pending collection (Excl. Bad Debt)</div>
    </div>
    <div class="stat-card stat-green">
      <div class="stat-label">Profit Made</div>
      <div class="stat-value" id="statProfit">${typeof __dashboardAnimRan !== 'undefined' && __dashboardAnimRan ? formatMoney(totalProfit) : 'K0.00'}</div>
      <div class="stat-sub">Total realized gains collected</div>
    </div>
  `;

  if (typeof __dashboardAnimRan !== 'undefined' && !__dashboardAnimRan) {
      animateValue(document.getElementById("statLoaned"), 0, totalLoaned, 1500);
      animateValue(document.getElementById("statOutstanding"), 0, totalOutstanding, 2000);
      animateValue(document.getElementById("statProfit"), 0, totalProfit, 2500);
      __dashboardAnimRan = true;
  }
}

function renderLoansTable() {
  recomputeAllLoans();
  const tbody = document.getElementById("loansTableBody");
  if (!tbody) return;

  try { wireClientSearchUI(); } catch(e) {}

  const search = (document.getElementById("searchInput")?.value || "").toLowerCase();
  const statusFilter = activeFilters.status;
  const planFilter = activeFilters.plan;

  const visibleLoans = (state.loans || []).filter(l => {
    const matchSearch = !search ||
      (l.clientName && l.clientName.toLowerCase().includes(search)) ||
      (l.id && l.id.toString().includes(search));
    const matchStatus = statusFilter === "All" || l.status === statusFilter;
    const matchPlan = planFilter === "All" || l.plan === planFilter;
    return matchSearch && matchStatus && matchPlan;
  });

  if (document.getElementById("loansCountLabel")) {
    document.getElementById("loansCountLabel").textContent = `${visibleLoans.length} records`;
  }

  if (document.getElementById("emptyState")) {
    const shouldShow = visibleLoans.length === 0;
    document.getElementById("emptyState").style.display = shouldShow ? "block" : "none";
  }

  tbody.innerHTML = visibleLoans.map((l, index) => {
    const percent = Math.min(100, Math.round(((l.paid || 0) / (l.totalDue || 1)) * 100));
    let progressColor = "var(--primary)";
    if (percent >= 100) progressColor = "var(--success)";
    else if (l.status === "OVERDUE") progressColor = "var(--danger)";
    else if (l.status === "DEFAULTED") progressColor = "var(--neutral)";

    const isOverdue = l.status === "OVERDUE";
    const balanceStyle = isOverdue ? 'class="text-danger-glow" style="font-weight:bold;"' : 'style="font-weight:bold;"';
    const avatarClass = `avatar-${l.id % 5}`;
    const isClosed = l.status === "PAID" || l.status === "DEFAULTED";
    const disabledAttr = isClosed ? 'disabled aria-disabled="true"' : '';
    const disabledOpacity = isClosed ? 'opacity:0.3;' : '';

    const waNumber = formatWhatsApp(l.clientPhone);
    const waMsg = encodeURIComponent(`Hi ${l.clientName}, reminder: Balance of ${formatMoney(l.balance)} was due on ${formatDate(l.dueDate)}.`);
    const waLink = waNumber ? `https://wa.me/${waNumber}?text=${waMsg}` : "#";
    const waStyle = waNumber ? "color:#4ade80;" : "color:#64748b; cursor:not-allowed;";

    // FIX APPLIED: Added data-loan-id="${l.id}" for reliable mobile interaction
    return `
    <tr class="row-${(l.status || 'active').toLowerCase()}" data-loan-id="${l.id}" style="animation-delay: ${index * 0.05}s">
      <td data-label="ID"><span style="opacity:0.5; font-size:0.8rem;">#${l.id}</span></td>
      <td data-label="Client">
        <div class="client-flex">
          <div class="avatar ${avatarClass}">${escapeHTML(getInitials(l.clientName))}</div>
          <div>
            <div style="font-weight:600; color:var(--text-main);">${escapeHTML(l.clientName)}</div>
            <div class="subtle" style="font-size:0.75rem;">${escapeHTML(l.clientPhone || '')}</div>
          </div>
        </div>
      </td>
      <td data-label="Item"><span style="color:var(--text-muted);">${escapeHTML(l.collateralItem || '-')}</span></td>
      <td data-label="Progress">
        <div style="min-width: 100px;">
          <div style="display:flex; justify-content:space-between; font-size:0.7rem; margin-bottom:4px;">
            <span>${percent}%</span>
            <span>${formatMoney(l.paid)} / ${formatMoney(l.totalDue)}</span>
          </div>
          <div style="background:rgba(255,255,255,0.1); height:6px; border-radius:4px; overflow:hidden;">
            <div style="width:${percent}%; background:${progressColor}; height:100%; border-radius:4px; transition: width 1s ease;"></div>
          </div>
        </div>
      </td>
      <td data-label="Start">${formatDate(l.startDate)}</td>
      <td data-label="Due">${formatDate(l.dueDate)}</td>
      <td data-label="Balance" ${balanceStyle}>${formatMoney(l.balance)}</td>
      <td data-label="Status"><span class="status-pill status-${(l.status || 'active').toLowerCase()}">${l.status}</span></td>
      <td data-label="Actions" style="text-align:right; white-space:nowrap;">
        <button class="btn-icon" onclick="openReceipt(${l.id})" title="Print Receipt">🖨️</button>
        <a href="${waLink}" target="_blank" rel="noopener noreferrer" class="btn-icon" style="${waStyle}; text-decoration:none; display:inline-flex;" title="WhatsApp">💬</a>
        <button class="btn-icon" onclick="openActionModal('PAY', ${l.id})" title="Pay" style="color:#38bdf8; ${disabledOpacity}" ${disabledAttr}>💳</button>
        <button class="btn-icon" onclick="openActionModal('WRITEOFF', ${l.id})" title="Bad Debt" style="color:#f87171; ${disabledOpacity}" ${disabledAttr}>🗑️</button>
        <button class="btn-icon" onclick="openActionModal('NOTE', ${l.id})" title="Note">📝</button>
      </td>
    </tr>
  `}).join("");
}

function renderRepaymentsTable() {
  const tbody = el("repaymentsTableBody");
  if (!tbody) return;
  tbody.innerHTML = (state.repayments || []).map(r => {
    const loan = state.loans.find(l => l.id === r.loanId);
    return `
     <tr>
       <td data-label="Date">${formatDate(r.date)}</td>
       <td data-label="Loan ID">#${r.loanId}</td>
       <td data-label="Client">${loan ? loan.clientName : 'Deleted'}</td>
       <td data-label="Recorder">${r.recordedBy || 'System'}</td>
       <td data-label="Amount" style="color:#34d399">+${formatMoney(r.amount)}</td>
     </tr>`;
  }).join("");
}

function renderMonthlyTable() {
  const tbody = el("monthlyTableBody");
  if (!tbody) return;

  const map = {};
  // Start with today as the minimum range end, work backwards to find true start
  let minDate = new Date();
  const updateMin = (d) => { if (d < minDate) minDate = d; };

  // 1. Aggregate Data & Find Range
  (state.loans || []).forEach(loan => {
    const d = parseDateSmart(loan.startDate);
    if (!d) return;
    updateMin(d);
    const key = getMonthKey(loan.startDate);
    if (!key) return;
    if (!map[key]) map[key] = { loansOut: 0, in: 0 };
    map[key].loansOut += Number(loan.amount || 0);
  });

  (state.repayments || []).forEach(r => {
    const d = parseDateSmart(r.date);
    if (!d) return;
    updateMin(d);
    const key = getMonthKey(r.date);
    if (!key) return;
    if (!map[key]) map[key] = { loansOut: 0, in: 0 };
    map[key].in += Number(r.amount || 0);
  });

  // 2. Generate Continuous List (From Today -> Back to Start)
  const today = new Date();
  let current = new Date(today.getFullYear(), today.getMonth(), 1);
  const start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);

  // Guard against infinite loop if date parsing fails (cap at 5 years back)
  const limitDate = new Date();
  limitDate.setFullYear(limitDate.getFullYear() - 5);
  if (start < limitDate) start.setTime(limitDate.getTime());

  let html = "";

  while (current >= start) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const key = `${y}-${m}`;
    const row = map[key] || { loansOut: 0, in: 0 };
    const net = row.in - row.loansOut;

    const dateLabel = current.toLocaleDateString("en-ZM", { month: 'short', year: 'numeric' });
    const isCurrent = (key === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);

    // Highlight current month with a border
    const borderStyle = isCurrent ? "border-left: 4px solid var(--primary);" : "border-left: 4px solid transparent;";

    html += `
    <tr style="${borderStyle} transition: all 0.2s ease;">
      <td data-label="Month">
        <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:800; font-size:1rem; color:var(--text-main); text-transform:uppercase; letter-spacing:0.5px;">${dateLabel}</span>
            ${isCurrent ? '<span class="status-pill status-active" style="font-size:0.5rem; padding:1px 5px; line-height:1; vertical-align:middle; letter-spacing:0.5px;">CURRENT</span>' : ''}
        </div>
      </td>
      <td data-label="Out" style="font-family:'Courier New', monospace; font-weight:600; color:var(--text-muted); opacity:0.9;">
        ${formatMoney(row.loansOut)}
      </td>
      <td data-label="In" style="font-family:'Courier New', monospace; font-weight:600; color:var(--text-main); opacity:0.9;">
        ${formatMoney(row.in)}
      </td>
      <td data-label="Net Flow">
        <span style="font-family:'Courier New', monospace; font-weight:800; font-size:1.1rem; color:${net >= 0 ? '#4ade80' : '#f87171'}">
          ${net > 0 ? '+' : ''}${formatMoney(net)}
        </span>
      </td>
    </tr>`;

    // Move back one month
    current.setMonth(current.getMonth() - 1);
  }

  // Handle empty history
  if (html === "") {
      html = `<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted); font-style:italic;">No records found yet.</td></tr>`;
  }

  tbody.innerHTML = html;
}
function setClientFilterHint(text) {
    const hint = el("clientFilterHint");
    if (!hint) return;
    hint.textContent = text || "";
}

function wireClientSearchUI() {
    const input = el("clientSearchInput");
    const clearBtn = el("clientSearchClearBtn");

    if (input && !input.__stallzWired) {
        input.__stallzWired = true;
        input.value = clientSearchQuery;

        const onInput = debounce(() => {
            window.setClientSearch(input.value);
        }, 90);

        input.addEventListener("input", onInput);
        input.addEventListener("search", () => {
            window.setClientSearch(input.value);
        });
    }

    if (clearBtn && !clearBtn.__stallzWired) {
        clearBtn.__stallzWired = true;
        clearBtn.addEventListener("click", () => {
            clientSearchQuery = "";
            if (input) input.value = "";
            renderClientsTable();
            try { input?.focus?.(); } catch(e) {}
        });
    }
}

// 👇 INSERT THIS NEW FUNCTION HERE
window.setClientSearch = function(q) {
  clientSearchQuery = q;
  renderClientsTable();
}

window.setClientView = function(view) {
    currentClientView = view;
    const activeTab = document.getElementById('tabActiveClients');
    const registeredTab = document.getElementById('tabRegisteredClients');

    if (activeTab) activeTab.classList.toggle('active', view === 'active');
    if (registeredTab) registeredTab.classList.toggle('active', view === 'registered');

    renderClientsTable();
};

function formatZambianPhone(phone) {
    if (!phone) return "-";
    let clean = phone.replace(/\D/g, '');
    if (clean.startsWith('0')) {
        clean = '260' + clean.substring(1);
    }
    if (clean.startsWith('260') && clean.length === 12) {
        return `+${clean.substring(0,3)} ${clean.substring(3,6)} ${clean.substring(6)}`;
    }
    return phone;
}

/* admin/app.js - renderClientsTable (Properly Aligned Card Layout) */

function renderClientsTable() {
    const tbody = document.getElementById("clientsTableBody");
    if (!tbody) return;

    const sharedUsers = window.StallzShared?.listUsers?.("client") || [];
    const allLoans = state.loans || [];

    const normalizePhone = (p) => String(p || "").replace(/\D/g, "").replace(/^0/, "260");

    const clientMap = {};

    const upsert = (key, patch) => {
        if (!clientMap[key]) clientMap[key] = {
            key,
            uid: null,
            name: "CLIENT",
            phone: "",
            email: "",
            nrc: "NOT SET",
            address: "NOT SET",
            createdAt: null,
            hasLoanHistory: false,
            source: "manual"
        };
        Object.assign(clientMap[key], patch || {});
        return clientMap[key];
    };

    sharedUsers.forEach(u => {
        const key = u?.uid ? `uid:${u.uid}` : (u?.email ? `email:${String(u.email).toLowerCase()}` : `name:${String(u.name||"client").toLowerCase()}`);
        upsert(key, {
            uid: u.uid || null,
            name: (u.name || u.email || "Client").toUpperCase(),
            phone: u.phone || "",
            email: u.email || "",
            nrc: u.nrc || "NOT SET",
            address: u.address || u.city || "NOT SET",
            createdAt: u.createdAt || u.createdOn || u.created || null,
            source: "registered"
        });
    });

    allLoans.forEach(loan => {
        const uid = loan?.clientUid ? String(loan.clientUid) : "";
        const phoneN = normalizePhone(loan?.clientPhone);
        const nameN = String(loan?.clientName || "Unknown").trim();

        let entry = null;

        if (uid && clientMap[`uid:${uid}`]) entry = clientMap[`uid:${uid}`];

        if (!entry && phoneN) {
            entry = Object.values(clientMap).find(c => normalizePhone(c.phone) === phoneN) || null;
        }

        if (!entry) {
            const key = phoneN ? `phone:${phoneN}` : `name:${nameN.toLowerCase()}`;
            entry = upsert(key, {
                uid: uid || null,
                name: nameN.toUpperCase(),
                phone: loan?.clientPhone || "",
                address: loan?.clientCity || loan?.city || loan?.address || "NOT SET",
                source: uid ? "registered" : "manual"
            });
        } else if (uid && !entry.uid) {
            entry.uid = uid;
        }

        entry.hasLoanHistory = true;
    });

    let displayList = Object.values(clientMap);

    if (currentClientView === "active") {
        displayList = displayList.filter(c => c.hasLoanHistory === true);
    } else if (currentClientView === "registered") {
        displayList = displayList.filter(c => c.source === "registered" && c.hasLoanHistory === false);
    }

    const totalInView = displayList.length;

    const q = String(clientSearchQuery || "").trim().toLowerCase();
    if (q) {
        displayList = displayList.filter(c => {
            const hay = [
                c.name, c.phone, c.email, c.nrc, c.address, c.uid, c.key
            ].map(v => String(v || "")).join(" ").toLowerCase();
            return hay.includes(q);
        });
    }

    displayList.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (q) setClientFilterHint(`Showing ${displayList.length} of ${totalInView} • Search: “${clientSearchQuery.trim()}”`);
    else setClientFilterHint(`Showing ${displayList.length} client${displayList.length === 1 ? "" : "s"}.`);

    if (displayList.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="padding:24px; text-align:center; color:var(--text-muted); font-style:italic; border:none;">
              No clients found in this category.
            </td>
          </tr>`;
        return;
    }

    const avatarIdx = (s) => {
        const str = String(s || "");
        let h = 0;
        for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
        return Math.abs(h) % 5;
    };

    // Card style (Padding moved to inner TD to fix layout conflicts)
    const cardStyle = `
        display: block !important;
        width: 100%;
        margin: 0 0 16px 0 !important;
        padding: 0 !important;
        background: var(--card-bg) !important;
        backdrop-filter: blur(20px) !important;
        -webkit-backdrop-filter: blur(20px) !important;
        border: var(--card-border) !important;
        box-shadow: var(--card-shadow) !important;
        border-radius: 16px !important;
        border-left: 4px solid var(--primary) !important;
        position: relative;
        overflow: hidden;
    `;

    // Reusable interior styles mapped to your variables for perfect Light/Dark mode support
    const gridStyle = `display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 12px; padding: 12px; margin-bottom: 16px;`;
    const labelStyle = `font-size: 0.65rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 700;`;
    const valStyle = `font-weight: 600; color: var(--text-main); font-size: 0.85rem; line-height: 1.3;`;

    window.adminClientCache = window.adminClientCache || {};

    tbody.innerHTML = displayList.map(c => {

        // Upgraded the APP LINKED pill to look like a modern, crisp badge
        const accountPill = c.uid
            ? `<span style="background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.2); padding: 4px 8px; border-radius: 6px; font-size: 0.65rem; font-weight: 800; letter-spacing: 0.5px; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                 APP LINKED
               </span>`
            : `<button onclick="generateLinkCode('${c.phone}', '${escapeHTML(c.name)}')" style="border-radius:6px; padding:4px 10px; font-size:0.65rem; font-weight:800; background:rgba(59, 130, 246, 0.1); color:#3b82f6; border:1px solid rgba(59, 130, 246, 0.3); cursor:pointer; transition:all 0.2s; white-space: nowrap;">Get Link Code</button>`;

        const idTag = c.uid ? `#${String(c.uid).substring(0, 6)}` : `MAN-${String(c.key).replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase()}`;

        const phonePretty = c.phone ? formatZambianPhone(c.phone) : "-";
        const emailPretty = c.email ? escapeHTML(c.email) : "-";
        const addressPretty = c.address ? escapeHTML(c.address) : "NOT SET";
        const createdPretty = c.createdAt ? formatDate(c.createdAt) : "";

        // Loan summary for this client
        const loansFor = (allLoans || []).filter(l => {
          const byUid = c.uid && l.clientUid && String(l.clientUid) === String(c.uid);
          const byPhone = c.phone && normalizePhone(l.clientPhone || '') === normalizePhone(c.phone || '');
          return !!(byUid || byPhone);
        });
        const loansCount = loansFor.length;
        let totalDue = 0, totalPaid = 0;
        loansFor.forEach(l => { totalDue += Number(l.totalDue || l.balance || 0); totalPaid += Number(l.paid || 0); });
        const balance = (totalDue - totalPaid) || 0;

        window.adminClientCache[c.key] = Object.assign({}, c, { loansCount, totalDue, totalPaid, balance, loans: loansFor });

        return `
          <tr class="client-card" style="${cardStyle}">
            <td style="display: block !important; width: 100% !important; padding: 16px !important; text-align: left !important; border: none !important;">

              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
                <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                  <div class="avatar avatar-${avatarIdx(c.uid || c.key)}" style="width: 44px; height: 44px; font-size: 1.1rem; box-shadow: 0 4px 10px rgba(0,0,0,0.2); flex-shrink: 0;">
                    ${escapeHTML(getInitials(c.name))}
                  </div>
                  <div style="min-width: 0; overflow: hidden;">
                    <div style="font-weight: 800; color: var(--text-main); font-size: 1.05rem; letter-spacing: -0.2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${escapeHTML(c.name)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                      ${createdPretty ? `Joined ${escapeHTML(createdPretty)}` : "Client Profile"}
                    </div>
                  </div>
                </div>
                <div style="font-family: 'Courier New', monospace; font-size: 0.75rem; color: var(--text-muted); background: var(--input-bg); padding: 4px 8px; border-radius: 6px; border: 1px solid var(--input-border); white-space: nowrap; flex-shrink: 0;">
                  ${escapeHTML(idTag)}
                </div>
              </div>

              <div style="${gridStyle}">
                <div style="overflow: hidden;">
                  <div style="${labelStyle}">Contact</div>
                  <div style="font-weight: 700; color: var(--primary); font-size: 0.9rem; font-family: 'Courier New', monospace;">${escapeHTML(phonePretty)}</div>
                  ${c.email ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${escapeHTML(emailPretty)}</div>` : ''}
                </div>

                <div style="text-align: right;">
                  <div style="${labelStyle}">NRC</div>
                  <div style="${valStyle}">${escapeHTML(c.nrc || "NOT SET")}</div>
                </div>

                <div>
                  <div style="${labelStyle}">Address</div>
                  <div style="${valStyle}">${addressPretty}</div>
                </div>
              </div>

              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 14px; border-top: 1px solid rgba(148, 163, 184, 0.15); flex-wrap: wrap; gap: 10px;">

                <div style="font-size: 0.85rem; color: var(--text-muted); display: flex; align-items: center; gap: 8px;">
                  <span style="display: flex; align-items: center; gap: 4px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
                    <span style="font-weight: 800; color: var(--text-main);">${loansCount}</span>
                  </span>
                  <span style="color: rgba(148, 163, 184, 0.4);">|</span>
                  <span>Bal: <span style="font-weight: 800; color: ${balance > 0 ? '#ef4444' : 'var(--text-main)'};">${__fmtMoney(balance)}</span></span>
                </div>

                <div style="display: flex; align-items: center; gap: 8px;">
                  ${accountPill}
                  <button class="btn-secondary btn-sm" onclick="openAdminClientDetails('${c.key}')" style="border-radius: 8px; padding: 6px 14px; font-size: 0.75rem; font-weight: 800; display: flex; align-items: center; gap: 4px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--text-main); cursor: pointer;">
                    Details
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
                  </button>
                </div>

              </div>

            </td>
          </tr>
        `;
    }).join("");
}

// Small utility used by admin views (same formatting as client portal)
function __fmtMoney(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return "K0.00";
  return "K" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Failsafe stub for capital history renderer (some builds call this)
function renderCapitalHistory(){
  try{
    const el = document.getElementById('capitalHistoryList');
    if(!el) return;
    el.innerHTML = '<div style="color:var(--text-muted)">No capital history available.</div>';
  }catch(e){ console.warn('renderCapitalHistory error', e); }
}


function renderAdminsTable() {
  const tbody = el("adminsTableBody");
  if (!tbody) return;
  tbody.innerHTML = (state.admins || []).map(a => `
  <tr>
    <td data-label="ID">#${a.id}</td>
    <td data-label="Name">${a.name}</td>
    <td data-label="Role">${a.role}</td>
    <td data-label="Phone">${a.phone || '-'}</td>
  </tr>`).join("");
}

// Open admin client details from cached client data
window.openAdminClientDetails = function(key){
  try{
    const data = (window.adminClientCache || {})[key];
    const modal = document.getElementById('adminClientDetailsModal');
    const target = document.getElementById('adminClientDetailsContent');
    if(!modal || !target) return;
    if(!data){ target.innerHTML = '<div style="color:var(--text-muted)">Client details not found.</div>'; modal.style.display='flex'; setTimeout(()=>modal.classList.remove('modal-hidden'),10); return; }

    // THE FIX: Added the "Read Notes / + Note" button right onto the loan card
    const loansHtml = (data.loans || []).map(l=>`
      <div style="padding:10px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                  <strong>Loan #${escapeHTML(l.id || l.loanId || '')}</strong> — <span class="status-pill status-${(l.status||'').toLowerCase()}" style="font-size:0.65rem; padding:2px 6px;">${escapeHTML(l.status||'')}</span>
                  <div style="margin-top:4px; font-size:0.85rem; color:var(--text-muted);">Balance: ${__fmtMoney(l.balance||l.totalDue||0)}</div>
              </div>
              ${l.notes ? `<button onclick="openActionModal('NOTE', ${l.id})" style="background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; cursor: pointer;">📝 Read Notes</button>` : `<button onclick="openActionModal('NOTE', ${l.id})" style="background: transparent; color: var(--text-muted); border: 1px dashed var(--border); padding: 4px 10px; border-radius: 6px; font-size: 0.7rem; cursor: pointer;">📝 + Note</button>`}
          </div>
      </div>
    `).join('') || '<div style="color:var(--text-muted); font-style:italic;">No loans.</div>';

    // EXTRACT ALL NOTES FOR THIS CLIENT (The tab we built earlier)
    let notesHtml = "";
    (data.loans || []).forEach(l => {
        if (l.notes) {
            notesHtml += `
                <div style="background: rgba(15, 23, 42, 0.4); border: 1px solid var(--border); padding: 12px; border-radius: 8px; margin-bottom: 10px;">
                    <div style="font-size: 0.7rem; color: var(--primary); font-weight: 800; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px;">From Loan #${l.id}</div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); white-space: pre-wrap; line-height: 1.5; font-family: monospace;">${escapeHTML(l.notes)}</div>
                </div>
            `;
        }
    });
    if (!notesHtml) notesHtml = '<div style="color:var(--text-muted); text-align:center; padding: 20px; font-style:italic;">No notes recorded for this client.</div>';

    target.innerHTML = `
      <div style="display:flex; gap:14px; align-items:flex-start;">
        <div style="min-width:0; flex:1;">
          <h3 style="margin:0 0 8px 0; color: #fff;">${escapeHTML(data.name||'Client')}</h3>
          <div style="font-size:0.85rem; color:var(--text-muted); font-family: monospace;">UID: ${escapeHTML(data.uid||'-')}</div>
          <div style="margin-top:8px; font-size:0.9rem;"><strong>Contact:</strong> ${escapeHTML(formatZambianPhone(data.phone) || '-') } • ${escapeHTML(data.email||'-')}</div>
          <div style="margin-top:8px; font-size:0.9rem;"><strong>NRC:</strong> ${escapeHTML(data.nrc||'-')} • <strong>Address:</strong> ${escapeHTML(data.address||'-')}</div>
          <div style="margin-top:8px; font-size:0.9rem;"><strong>Joined:</strong> ${escapeHTML(data.createdAt? formatDate(data.createdAt):'-')}</div>
        </div>
        <div style="width:180px; text-align:right;">
          <div style="font-weight:800; font-size:1.2rem; color:var(--text-main)">${data.loansCount||0} <span style="font-size:0.8rem; font-weight:600; color:var(--text-muted)">Loans</span></div>
          <div style="margin-top:2px; font-weight:800; font-size:1rem; color:${data.balance > 0 ? '#ef4444' : 'var(--text-main)'}">${__fmtMoney(data.balance||0)}</div>
          <div style="font-size:0.75rem; color:var(--text-muted)">Total Balance</div>
        </div>
      </div>

      <div style="margin-top: 20px; border-bottom: 1px solid var(--border); display: flex; gap: 20px;">
          <div id="tabBtnClientLoans" onclick="switchClientDetailsTab('loans')" style="padding-bottom: 8px; cursor: pointer; font-weight: 800; color: var(--primary); border-bottom: 2px solid var(--primary); transition: all 0.2s;">Loan History</div>
          <div id="tabBtnClientNotes" onclick="switchClientDetailsTab('notes')" style="padding-bottom: 8px; cursor: pointer; font-weight: 600; color: var(--text-muted); border-bottom: 2px solid transparent; transition: all 0.2s;">Client Notes Log</div>
      </div>

      <div id="clientDetailsLoansView" style="margin-top:15px; max-height:300px; overflow:auto; display: block;">
          ${loansHtml}
      </div>

      <div id="clientDetailsNotesView" style="margin-top:15px; max-height:300px; overflow:auto; display: none;">
          ${notesHtml}
      </div>

      <div style="margin-top:15px; display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" onclick="window.setClientSearch('${escapeHTML(data.name)}'); switchOverviewTab('loans'); document.getElementById('adminClientDetailsModal').style.display='none';">Close & View Client In Table</button>
      </div>
    `;

    modal.style.display='flex'; setTimeout(()=>modal.classList.remove('modal-hidden'),10);
  }catch(e){ console.error(e); }
};

// Tab Switcher Logic
window.switchClientDetailsTab = function(tab) {
    const lView = document.getElementById("clientDetailsLoansView");
    const nView = document.getElementById("clientDetailsNotesView");
    const lBtn = document.getElementById("tabBtnClientLoans");
    const nBtn = document.getElementById("tabBtnClientNotes");

    if (tab === 'loans') {
        lView.style.display = 'block'; nView.style.display = 'none';
        lBtn.style.color = 'var(--primary)'; lBtn.style.fontWeight = '800'; lBtn.style.borderBottom = '2px solid var(--primary)';
        nBtn.style.color = 'var(--text-muted)'; nBtn.style.fontWeight = '600'; nBtn.style.borderBottom = '2px solid transparent';
    } else {
        lView.style.display = 'none'; nView.style.display = 'block';
        nBtn.style.color = 'var(--primary)'; nBtn.style.fontWeight = '800'; nBtn.style.borderBottom = '2px solid var(--primary)';
        lBtn.style.color = 'var(--text-muted)'; lBtn.style.fontWeight = '600'; lBtn.style.borderBottom = '2px solid transparent';
    }
};
/* ============================================================================
 * 8.0 | RECEIPT GENERATION
 * ============================================================================ */


window.openReceipt = function(loanId) {
  const loan = state.loans.find(l => l.id == loanId);
  if (!loan) return;

  // Sort history (not strictly used in this compact receipt, but kept for logic)
  const history = state.repayments
    .filter(r => r.loanId === loan.id)
    .sort((a, b) => (parseDateSmart(b.date)?.getTime() || 0) - (parseDateSmart(a.date)?.getTime() || 0));

  // Determine Status Color
  let statusColor = "#333";
  let statusText = loan.status;
  if (loan.balance <= 0.01) { statusColor = "#16a34a"; statusText = "PAID IN FULL"; }
  else if (loan.status === "OVERDUE") { statusColor = "#dc2626"; }

  // Calculate Interest Percentage
  const interestPercent = ((loan.rate || 0) * 100).toFixed(0);

  const receiptHTML = `
    <div style="font-family: 'Segoe UI', sans-serif; color: #1e293b; padding: 20px; font-size: 10px; background: white;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <img src="../assets/logo_images/my-logo.png" style="height: 32px; width: auto; display:block;" onerror="this.style.display='none'">
            <div>
              <h1 style="margin: 0; font-size: 14px; color: #1e293b; text-transform: uppercase; font-weight:800; letter-spacing: 0.5px;">Stallz Loans</h1>
              <p style="margin: 1px 0 0; font-size: 8px; color: #64748b; font-weight:600;">Quick, Easy, Reliable</p>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="color: #64748b;">Receipt #: <strong style="color: #0f172a;">${loan.id}</strong></div>
            <div style="color: #64748b;">Date: <strong style="color: #0f172a;">${new Date().toLocaleDateString()}</strong></div>
            <div style="margin-top:2px; font-size: 8px; font-weight:700; color:${statusColor}; border:1px solid ${statusColor}; padding:1px 4px; border-radius:3px; display:inline-block;">${statusText}</div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; margin-bottom: 12px; background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;">
          <div>
            <div style="font-size: 8px; text-transform: uppercase; color: #94a3b8; font-weight: 700; margin-bottom: 2px;">Client</div>
            <div style="font-size: 11px; font-weight: 700; color: #334155;">${escapeHTML(loan.clientName)}</div>
            <div style="font-size: 9px; color: #64748b;">${loan.clientPhone || ''}</div>
          </div>
          <div style="text-align: right;">
             <div style="font-size: 8px; text-transform: uppercase; color: #94a3b8; font-weight: 700; margin-bottom: 2px;">Due Date</div>
             <div style="font-size: 11px; font-weight: 700; color: ${statusColor};">${formatDate(loan.dueDate)}</div>
             <div style="font-size: 8px; color: #94a3b8; margin-top:2px;">Item: ${escapeHTML(loan.collateralItem)}</div>
          </div>
        </div>

        <div style="width: 100%; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9;">
                <span>Principal</span>
                <span style="font-weight:600;">${formatMoney(loan.amount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9;">
                <span>Interest/Fees (${interestPercent}%)</span>
                <span style="font-weight:600;">${formatMoney(loan.totalDue - loan.amount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9;">
                <span style="font-weight: 700; color: #0f172a;">Total Due</span>
                <span style="font-weight: 700; color: #0f172a;">${formatMoney(loan.totalDue)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9; color: #16a34a;">
                <span>Less: Paid</span>
                <span>- ${formatMoney(loan.paid)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #0f172a; margin-top: 2px;">
                <span style="font-weight: 800; font-size:12px;">BALANCE</span>
                <span style="font-weight: 800; font-size:14px; color: ${statusColor};">${formatMoney(loan.balance)}</span>
            </div>

            ${loan.notes ? `
            <div style="margin-top: 12px; padding: 8px; background: #fefce8; border: 1px solid #fef08a; border-radius: 6px;">
                <div style="font-size: 7px; text-transform: uppercase; color: #854d0e; font-weight: 800; margin-bottom: 2px;">Admin Notes</div>
                <div style="font-size: 9px; color: #713f12; font-style: italic; white-space: pre-wrap;">"${escapeHTML(loan.notes)}"</div>
            </div>
            ` : ''}
        </div>

        <div style="margin-top: 5px; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
            <div style="font-size: 7px; color: #94a3b8; text-align: justify; line-height: 1.35;">
            <strong>Terms & Conditions:</strong> By accepting this loan, you agree that failure to repay by the due date may result in the forfeiture and sale of the collateral item listed above to recover the loan amount.
            </div>
            <div style="text-align: center; margin-top: 10px; font-size: 9px; font-weight: 600; color: #1e293b;">Thank you for your business!</div>
            <div style="margin-top: 2px; text-align: center; font-size: 6px; color: #cbd5e1;">Generated by Stallz Loans Admin</div>
        </div>
    </div>
  `;

  const contentBox = document.getElementById("receiptContent");
  if (contentBox) contentBox.innerHTML = receiptHTML;

  // Show Modal
  const modal = document.getElementById("receiptModal");
  if (modal) {
      modal.style.display = "flex";
      setTimeout(() => modal.classList.remove("modal-hidden"), 10);
  }

  // Setup Download Button
  const dlBtn = document.getElementById("downloadImageBtn");
  if (dlBtn) {
      dlBtn.onclick = function() {
        showToast("Generating Image...", "success");

        html2canvas(contentBox, {
          scale: 3,
          backgroundColor: "#ffffff",
          useCORS: true
        }).then(canvas => {
          const link = document.createElement('a');
          link.download = `Receipt_${loan.clientName.replace(/\s/g, '_')}_${loan.id}.png`;
          link.href = canvas.toDataURL("image/png");
          link.click();
        }).catch(err => {
          console.error(err);
          showToast("Error generating image", "error");
        });
      };
  }
};

/* ============================================================================
 * 9.0 | INTERACTION & UX HANDLERS
 * ============================================================================ */

window.setFilter = function(type, value, btnElement) {
  if (typeof vibrate === "function") vibrate([15]);
  activeFilters[type] = value;
  const parent = btnElement.parentElement;
  if (parent) {
    parent.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btnElement.classList.add('active');
  }
  renderLoansTable();
}

window.switchOverviewTab = function(tabName, btnElement) {
  if (typeof vibrate === "function") vibrate([15]);

  // FIX: Scroll to top when switching so content isn't hidden
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const dash = document.getElementById("tab-dashboard");
  const loans = document.getElementById("tab-loans");

  if (dash) { dash.style.display = "none"; dash.classList.remove("animate-in"); }
  if (loans) { loans.style.display = "none"; loans.classList.remove("animate-in"); }

  const target = document.getElementById("tab-" + tabName);
  if (target) {
    target.style.display = "block";
    void target.offsetWidth;
    target.classList.add("animate-in");

    // --- NEW: SMART OFFLINE CHECK ---
    // If the device is offline, this instantly drops the blurred "Connection Lost" blocker over the card
    if (typeof window.enforceOfflineView === 'function') {
        window.enforceOfflineView(target.querySelector(".card-inner") || target);
    }
  }

  const buttons = document.querySelectorAll(".sketch-btn");
  buttons.forEach(b => b.classList.remove("active"));

  if (!btnElement) {
      if (tabName === 'dashboard') btnElement = document.querySelector("button[onclick*='dashboard']");
      if (tabName === 'loans') btnElement = document.querySelector("button[onclick*='loans']");
  }

  if (btnElement) btnElement.classList.add("active");
};

function updateNavHighlight(activeBtnId) {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('nav-btn-active');
  });
  const targetBtn = document.getElementById(activeBtnId);
  if (targetBtn) {
    targetBtn.classList.add('nav-btn-active');
  }
}

/* admin/app.js - Fixed closeAllModals to prevent animation conflict */

window.closeAllModals = function(resetNav = true, exceptId = null, immediate = false) {
  const ids = ['monthlyModal', 'clientsModal', 'adminsModal'];

  ids.forEach(id => {
    if (id === exceptId) return;
    const m = document.getElementById(id);
    if (!m) return;

    // Check if visible
    const isVisible = (m.style.display === "flex" || m.style.display === "block") && !m.classList.contains("modal-hidden");
    if (!isVisible) return;

    // 1. CRITICAL FIX: Remove 'switching' class so the Close Animation takes priority
    m.classList.remove("switching");

    // 2. Immediate mode (for fast switching between tabs)
    if (immediate) {
      m.classList.add("modal-hidden");
      m.style.display = "none";
      return;
    }

    // 3. Standard Close (Animates out nicely)
    m.classList.add("modal-hidden");

    // Wait for the CSS animation (smoothSlideOut) to finish
    setTimeout(() => {
      if (m.classList.contains("modal-hidden")) m.style.display = "none";
    }, 350);
  });

  // Always close notifications dropdown
  const dd = document.getElementById("notifDropdown");
  if (dd) dd.classList.remove("show");

  if (resetNav) {
    updateNavHighlight('navMainBtn');
    if (typeof vibrate === "function") vibrate([10]);
  }
}
window.openPopup = function(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  // 1. STOP any pending close timers to prevent glitches
  if (typeof _modalTimers !== 'undefined' && _modalTimers[modalId]) {
      clearTimeout(_modalTimers[modalId]);
      delete _modalTimers[modalId];
  }

  // 2. CHECK: Are we switching between main tabs? (Clients <-> Monthly)
  const navSheets = ['monthlyModal', 'clientsModal', 'adminsModal'];
  const isNavSheet = navSheets.includes(modalId);
  let isSwitching = false;

  if (isNavSheet) {
      // Look for other open sheets
      const otherOpen = navSheets.find(id => {
          if (id === modalId) return false;
          const el = document.getElementById(id);
          // Check if it's currently visible
          return el && el.style.display !== "none" && !el.classList.contains("modal-hidden");
      });
      if (otherOpen) isSwitching = true;
  }

  // 3. TOGGLE LOGIC
  const isOpen = (modal.style.display === "flex" || modal.style.display === "block") && !modal.classList.contains("modal-hidden");
  if (isOpen) {
    if (typeof window.closePopup === 'function') window.closePopup(modalId);
    return;
  }

  // 4. PREPARE UI
  // Close notifications dropdown
  const dd = document.getElementById("notifDropdown");
  if (dd) dd.classList.remove("show");

  // ⚡ CRITICAL FIX: If switching, pass 'true' to close others INSTANTLY (No laggy animation)
  if (typeof window.closeAllModals === 'function') {
      window.closeAllModals(false, modalId, isSwitching);
  }

  // 5. OPEN THE NEW MODAL
  modal.style.display = "flex";
  modal.classList.remove("modal-hidden");

  // --- NEW: SMART OFFLINE CHECK ---
  // Instantly blocks the modal content if the device is offline
  if (typeof window.enforceOfflineView === 'function') {
      window.enforceOfflineView(modal.querySelector(".modal"));
  }

  // 6. APPLY "FAST SWITCH" ANIMATION CLASS
  // If switching, we use a lighter fade-in. If opening fresh, we use the nice bounce.
  if (isSwitching) {
      modal.classList.add("switching");
  } else {
      modal.classList.remove("switching");
      // Reset animation for fresh open
      const inner = modal.querySelector(".modal");
      if (inner) {
          inner.style.animation = "none";
          void inner.offsetHeight; // force reflow
          inner.style.animation = "";
      }
  }

  if (typeof vibrate === "function") vibrate([15]);

  // Update Nav Highlights
  if (typeof updateNavHighlight === 'function') {
      if (modalId === 'monthlyModal') updateNavHighlight('navMonthlyBtn');
      if (modalId === 'clientsModal') updateNavHighlight('navClientsBtn');
      if (modalId === 'adminsModal') updateNavHighlight('navAdminsBtn');
  }
}
window.closePopup = function(id) {
  const modal = document.getElementById(id);
  if (modal) {
      modal.classList.add("modal-hidden");
      setTimeout(() => { modal.style.display = "none"; }, 300);
  }
  updateNavHighlight('navMainBtn');
}

window.closeReceiptModal = function() {
    const m = document.getElementById('receiptModal');
    if (m) {
        m.classList.add('modal-hidden');
        setTimeout(() => { m.style.display = 'none'; }, 300);
    }
}


/* Fixed: Removes inline styles so Day Mode works correctly */

window.openActionModal = function(action, loanId) {
  const modal = el("actionModal");
  if (!modal) return;

  // Set global state
  currentAction = action;
  currentLoanId = loanId;

  const titleEl  = el("actionModalTitle");
  const subEl    = el("actionModalSubtitle");
  const bodyEl   = el("actionModalBody");
  const helperEl = el("actionModalHelper");
  const confirmBtn = el("actionModalConfirmBtn");

  const loan = (state.loans || []).find(l => String(l.id) === String(loanId));
  const today = new Date().toISOString().split("T")[0];

  try { if (loan) computeDerivedFields(loan); } catch(e) {}

  // Reset UI
  if (subEl) subEl.textContent = "";
  if (helperEl) helperEl.textContent = "";
  if (bodyEl) bodyEl.innerHTML = "";

  // Standard component: Note History Viewer
  const getNoteHistoryHtml = () => loan?.notes ? `
    <div style="background:rgba(0,0,0,0.15); padding:12px; border-radius:8px; font-size:0.85rem; color:var(--text-main); max-height:120px; overflow-y:auto; white-space:pre-wrap; border: 1px solid var(--border); font-family: monospace; line-height: 1.4;">${escapeHTML(loan.notes)}</div>
  ` : `<div style="font-size:0.82rem; color:var(--text-muted); font-style:italic; padding: 10px; text-align: center; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px dashed var(--border);">There are no notes for this loan.</div>`;

  // Helper to create consistent rows
  const makeRow = (label, innerHtml) => `
    <div style="display:flex; flex-direction:column; gap:8px; margin:10px 0;">
      <div style="font-size:.78rem; letter-spacing:.12em; text-transform:uppercase; font-weight:800; color:var(--primary); opacity:.9;">${label}</div>
      ${innerHtml}
    </div>
  `;

  if (action === "PAY") {
    if (titleEl) titleEl.textContent = "Record Payment";
    if (subEl && loan) subEl.textContent = `Loan #${loan.id} • Bal: ${Number(loan.balance || 0).toFixed(2)}`;

    if (confirmBtn) {
      confirmBtn.textContent = "Save Payment";
      confirmBtn.className = "btn btn-primary";
    }

    const balanceVal = loan ? Number(loan.balance || 0).toFixed(2) : "";

    // SMART UPDATE: Included Note History in Payment window for better context
    const body = [
      makeRow("Loan History Context", getNoteHistoryHtml()),
      makeRow("Payment Amount", `<input id="actAmount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${balanceVal}">`),
      makeRow("Date Received", `<input id="actDate" type="date" value="${today}">`),
      makeRow("Payment Note (optional)", `<textarea id="actNote" rows="2" placeholder="e.g. Paid via MTN MoMo..."></textarea>`)
    ].join("");

    if (bodyEl) bodyEl.innerHTML = body;

  } else if (action === "NOTE") {
    if (titleEl) titleEl.textContent = "Loan Interaction Log";
    if (subEl && loan) subEl.textContent = `Loan #${loan.id} • ${loan.clientName || "—"}`;

    if (confirmBtn) {
      confirmBtn.textContent = "Append to Log";
      confirmBtn.className = "btn btn-secondary";
    }

    const body = [
      makeRow("Existing History", getNoteHistoryHtml()),
      makeRow("New Entry", `<textarea id="actNote" rows="4" placeholder="Write your update here. It will be timestamped automatically..."></textarea>`)
    ].join("");

    if (bodyEl) bodyEl.innerHTML = body;

  } else if (action === "WRITEOFF") {
    if (titleEl) titleEl.textContent = "Mark as Bad Debt";
    if (subEl && loan) subEl.textContent = `Loan #${loan.id} • IRREVERSIBLE ACTION`;

    if (confirmBtn) {
      confirmBtn.textContent = "Confirm Write-Off";
      confirmBtn.className = "btn btn-danger";
    }

    const body = [
      makeRow("Reason for Write-Off (Mandatory)", `<textarea id="actNote" rows="5" placeholder="Please explain why this loan cannot be recovered (e.g. collateral seized, client moved)..."></textarea>`)
    ].join("");

    if (bodyEl) bodyEl.innerHTML = body;
    if (helperEl) helperEl.textContent = "Note: This will close the loan and record a total loss in the capital ledger.";
  }

  // ⚡ Z-INDEX ENFORCEMENT: Ensure it pops to the front
  modal.style.display = "flex";
  modal.style.setProperty("z-index", "100060", "important");
  modal.classList.remove("modal-hidden");

  // Force re-animation
  const inner = modal.querySelector(".modal");
  if (inner) {
    inner.style.animation = "none";
    void inner.offsetHeight;
    inner.style.animation = "";
  }

  setTimeout(() => {
    // Smart Focus: If paying, focus amount. Otherwise focus textarea.
    const input = action === "PAY" ? el("actAmount") : el("actNote");
    if (input) input.focus();
  }, 100);

  if (typeof vibrate === "function") vibrate([20]);
};


// FIX: New function to properly close the Repayment/Action window
window.closeActionModal = function() {
    const am = document.getElementById("actionModal");
    if(am) {
        am.classList.add("modal-hidden");
        setTimeout(() => { am.style.display = "none"; }, 300);
    }
    currentAction = "NONE";
    currentLoanId = null;
}

function toggleProfileSidebar() {
  const sb = document.getElementById("profileSidebar");
  const ov = document.getElementById("profileOverlay");
  if (sb.classList.contains("open")) {
    sb.classList.remove("open");
    ov.classList.add("hidden");
  } else {
    sb.classList.add("open");
    ov.classList.remove("hidden");
    document.getElementById("notifDropdown")?.classList.remove("show");
  }
}

function toggleNotifications() {
  const dd = document.getElementById("notifDropdown");
  const btn = document.getElementById("notifBtn");
  if (!dd) return;
  dd.classList.toggle("show");
  if (typeof vibrate === "function") vibrate([10]);

  const sidebar = document.getElementById("profileSidebar");
  const overlay = document.getElementById("profileOverlay");
  if (sidebar && sidebar.classList.contains("open")) {
      sidebar.classList.remove("open");
      if (overlay) overlay.classList.add("hidden");
  }
}

document.addEventListener("click", function(event) {
  const dd = document.getElementById("notifDropdown");
  const btn = document.getElementById("notifBtn");
  if (dd && dd.classList.contains("show") && !dd.contains(event.target) && !btn.contains(event.target)) {
    dd.classList.remove("show");
  }
});


function setupMobileUX() {
  // 1. Android/Chrome Install Prompt
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = el("installAppBtn");
    if (btn) {
      btn.style.display = "inline-flex";
      btn.addEventListener('click', () => {
        if(typeof vibrate === "function") vibrate([30]);
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            btn.style.display = 'none';
          }
          deferredPrompt = null;
        });
      });
    }
  });

  // 2. Long-Press on Loan Row (Quick Pay) with Jitter Tolerance
  let longPressTimer;
  const touchDuration = 800; // 0.8 seconds
  let startX = 0;
  let startY = 0;

  document.addEventListener("touchstart", (e) => {
    const row = e.target.closest("tr");
    if (!row) return;

    // FIX: Read ID from the robust data attribute
    const rawId = row.getAttribute("data-loan-id");
    if (!rawId) return;

    const loanId = parseInt(rawId);

    // Track touch start position
    if (e.touches && e.touches[0]) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }

    if (loanId) {
      longPressTimer = setTimeout(() => {
        if(typeof vibrate === "function") vibrate([40, 40]); // Double buzz feedback
        openActionModal("PAY", loanId);
      }, touchDuration);
    }
  }, { passive: true });

  // Handle movement (allow small jitter of 10px)
  document.addEventListener("touchmove", (e) => {
      if (!longPressTimer) return;

      if (e.touches && e.touches[0]) {
          const moveX = e.touches[0].clientX;
          const moveY = e.touches[0].clientY;

          // Calculate distance moved
          const diffX = Math.abs(moveX - startX);
          const diffY = Math.abs(moveY - startY);

          // If moved more than 10px, it's a scroll -> cancel timer
          if (diffX > 10 || diffY > 10) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
          }
      } else {
          clearTimeout(longPressTimer);
      }
  }, { passive: true });

  document.addEventListener("touchend", () => clearTimeout(longPressTimer));
  document.addEventListener("touchcancel", () => clearTimeout(longPressTimer));

  // 3. iOS Install Modal Logic
  function checkIosInstall() {
    const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
    const isStandalone = window.navigator.standalone === true;

    if (isIos && !isStandalone) {
      setTimeout(() => {
        const modal = document.getElementById("iosInstallModal");
        if (modal) {
            modal.style.display = "flex";
            setTimeout(() => modal.classList.remove("modal-hidden"), 10);
        }
      }, 3000); // Delayed slightly to be less intrusive
    }
  }

  document.getElementById("closeIosModalBtn")?.addEventListener("click", () => {
    const modal = document.getElementById("iosInstallModal");
    if (modal) {
        modal.classList.add("modal-hidden");
        setTimeout(() => { modal.style.display = "none"; }, 300);
    }
  });

  checkIosInstall();
}

function showLoanConfirmation() {
    const draft = wizardDraft;

    const clientName = draft.clientName || "Unknown";
    const amount = Number(draft.amount) || 0;
    const item = draft.collateralItem || "Unsecured";
    const plan = draft.plan || "Weekly";
    const interestOverride = draft.customInterest ? Number(draft.customInterest) : null;

    let rate = INTEREST_BY_PLAN[plan] || 0;
    if (interestOverride !== null) rate = interestOverride / 100;

    const totalDue = amount * (1 + rate);

    const start = draft.startDate ? parseDateSmart(draft.startDate) : new Date();
    let due = new Date(start);

    if (plan === "Monthly") {
        due = addMonthsSafe(due, 1);
    } else {
        const days = DAYS_BY_PLAN[plan] || 7;
        due.setDate(due.getDate() + days);
    }

    el("confAmount").textContent = formatMoney(amount);
    el("confClient").textContent = clientName;
    el("confItem").textContent = item;
    el("confDuration").textContent = plan;
    el("confInterest").textContent = (rate * 100).toFixed(0) + "%";
    el("confDueDate").textContent = formatDate(due.toISOString().split('T')[0]);
    el("confTotal").textContent = formatMoney(totalDue);

    openPopup("loanConfirmationModal");
}

function setActiveView(view) {
  document.querySelectorAll("[id^='view-']").forEach(v => v.classList.add("view-hidden"));
  const target = el(`view-${view}`);
  if (target) target.classList.remove("view-hidden");
}

function updateWizard(direction = "next") {
  const step = LOAN_STEPS[wizardStep];
  const wrapper = el("wizardWrapper");

  wrapper.classList.remove("slide-in-right", "slide-out-left", "slide-in-left");
  wrapper.classList.add(direction === "next" ? "slide-in-right" : "slide-in-left");

  el("modalStepLabel").textContent = `Step ${wizardStep + 1} of ${LOAN_STEPS.length}`;
  el("modalFieldLabel").textContent = step.label;
  el("modalHelper").textContent = step.helper;

  el("modalStepDots").innerHTML = LOAN_STEPS.map((_, i) =>
    `<div class="step-dot ${i === wizardStep ? 'active' : ''}"></div>`
  ).join("");

  const container = el("modalFieldContainer");
  container.innerHTML = "";

  let input;
  if (step.type === "select") {
    input = document.createElement("select");
    step.options.forEach(opt => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      input.appendChild(o);
    });
  } else if (step.type === "textarea") {
    input = document.createElement("textarea");
    input.rows = 3;
  } else {
    input = document.createElement("input");
    input.type = step.type;
    if (step.placeholder) input.placeholder = step.placeholder;
    input.setAttribute("autocomplete", "off");

    if (step.key === "clientName") {
      input.setAttribute("list", "clientList");

      const historyNames = state.loans.map(l => l.clientName).filter(Boolean);

      let regNames = [];
      try {
          const users = window.StallzShared?.listUsers?.("client") || [];
          regNames = users.map(u => u.name || u.fullName).filter(Boolean);
      } catch(e) {}

      const uniqueClients = [...new Set([...historyNames, ...regNames])].sort();

      const dataList = document.getElementById("clientList");
      if (dataList) {
        dataList.innerHTML = uniqueClients.map(name => `<option value="${name}">`).join("");
      }
    }
  }

  if (wizardDraft[step.key]) input.value = wizardDraft[step.key];

  input.id = "wizardInput";
  container.appendChild(input);

  if (step.type === "date") {
    const chipContainer = document.createElement("div");
    chipContainer.style.cssText = "display:flex; gap:10px; margin-top:12px;";

    const createChip = (text, dateVal) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary btn-sm";
      btn.style.cssText = "padding:6px 12px; font-size:0.75rem; border-radius:20px; border:1px solid var(--primary); color:var(--primary); background:rgba(59, 130, 246, 0.1);";
      btn.textContent = text;
      btn.onclick = () => {
        el("wizardInput").value = dateVal;
        vibrate([20]);
      };
      return btn;
    };

    chipContainer.appendChild(createChip("Today", getLocalDateVal()));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    chipContainer.appendChild(createChip("Yesterday", yesterdayStr));

    container.appendChild(chipContainer);
  }

  setTimeout(() => input.focus(), 100);
  el("modalBackBtn").style.visibility = wizardStep === 0 ? "hidden" : "visible";
  el("modalNextBtn").textContent = wizardStep === LOAN_STEPS.length - 1 ? "Finish & Save" : "Next →";
}

/* admin/app.js - saveNewLoan (With Admin Tracking Fix) */

function saveNewLoan() {
  const draft = wizardDraft;
  const newId = generateLoanId(); // Use the safe generator

  // 1. Get Current Admin Details (The Fix)
  let creatorName = "Admin";
  let creatorEmail = "system@stallz";

  if (state.currentUserProfile) {
      // Use profile name if available
      creatorName = state.currentUserProfile.name || state.currentUserProfile.firstname || "Admin";
      creatorEmail = state.currentUserProfile.email || "";
  } else if (state.user) {
      // Fallback to auth user email
      creatorEmail = state.user.email;
      creatorName = state.user.email.split('@')[0].toUpperCase();
  }

  const newLoan = {
    id: newId,
    clientName: (draft.clientName || "Client").trim(),
    clientPhone: (draft.clientPhone || "").trim(),
    amount: Number(draft.amount),
    plan: draft.plan,
    customInterest: draft.customInterest ? Number(draft.customInterest) : null,
    collateralItem: (draft.collateralItem || "").trim(),
    collateralValue: draft.collateralValue ? Number(draft.collateralValue) : 0,
    startDate: draft.startDate,
    status: "ACTIVE",
    notes: (draft.notes || "").trim(),
    paid: 0,
    saleAmount: 0,
    profitCollected: 0,
    isDefaulted: false,
    clientUid: null,

    // ✅ ADDED: Track who created this loan
    createdBy: creatorName,
    createdEmail: creatorEmail,

    createdAt: new Date().toISOString()
  };

  // 2. Update Local State
  if (!state.loans) state.loans = [];
  state.loans.unshift(newLoan);
  computeDerivedFields(newLoan);

  // 3. ATOMIC CLOUD SAVE (schema-aware: supports legacy array & object nodes)
  if (!OFFLINE_TEST_MODE && dataRef) {
    try {
      const loansShape = state.__loansContainerType || "array";
      // If legacy is an array, append via transaction to avoid creating mixed-key duplicates.
      if (loansShape === "array") {
        dataRef.child("loans").transaction((current) => {
          let arr = current;
          if (Array.isArray(arr)) {
            // ok
          } else if (arr && typeof arr === "object") {
            // If it already became an object (numeric keys), normalize to a compact array
            arr = Object.values(arr).filter(v => v && typeof v === "object");
          } else {
            arr = [];
          }
          arr.push(newLoan);
          return arr;
        }, (error, committed) => {
          if (error || !committed) {
            showToast("Cloud Sync Failed", "error");
            return;
          }
          showToast("Loan Created!", "success");
          if (newLoan.clientUid) syncSingleLoanToClient(newLoan);
        }, false);
      } else {
        // Object map mode: safe to write by id
        newLoan.__loanPath = `loans/${newId}`;
        newLoan.__primaryLoanPath = newLoan.__loanPath;

        const updates = {};
        updates[`loans/${newId}`] = newLoan;

        dataRef.update(updates).then(() => {
          showToast("Loan Created!", "success");
          if (newLoan.clientUid) syncSingleLoanToClient(newLoan);
        }).catch(() => showToast("Cloud Sync Failed", "error"));
      }
    } catch (e) {
      console.error(e);
      showToast("Cloud Sync Failed", "error");
    }
  } else {
    saveState();
  }

  closePopup("loanModal");
  refreshUI();
  switchOverviewTab('loans');
}

function handleWizardNext() {
  const step = LOAN_STEPS[wizardStep];
  const input = el("wizardInput");
  const val = input.value.trim();

  if (step.required && !val) {
    input.style.border = "1px solid #ef4444";
    setTimeout(() => input.style.border = "", 2000);
    if(typeof vibrate === "function") vibrate([50]);
    return;
  }

  wizardDraft[step.key] = val;

  if (step.key === "clientName") {
      const lowerName = val.toLowerCase();
      let foundPhone = null;

      const loanMatch = (state.loans || [])
          .filter(l => l.clientName && l.clientName.toLowerCase() === lowerName)
          .sort((a, b) => (Number(b.id)||0) - (Number(a.id)||0))[0];

      if (loanMatch && loanMatch.clientPhone) foundPhone = loanMatch.clientPhone;

      if (!foundPhone) {
          try {
              const users = window.StallzShared?.listUsers?.("client") || [];
              const userMatch = users.find(u => (u.name || u.fullName || "").toLowerCase() === lowerName);
              if (userMatch && userMatch.phone) foundPhone = userMatch.phone;
          } catch(e) {}
      }

      if (foundPhone) {
          wizardDraft["clientPhone"] = foundPhone;
      }
  }

  if (wizardStep < LOAN_STEPS.length - 1) {
    wizardStep++;
    updateWizard("next");
  } else {
    showLoanConfirmation();
  }
}

function handleWizardBack() {
  if (wizardStep > 0) {
    wizardStep--;
    updateWizard("back");
  }
}

/* ============================================================================
 * 10.0 | APP INITIALIZATION
 * ============================================================================ */

// ==========================================
// ROBUST ADMIN LOGOUT LOGIC (Custom UI)
// ==========================================
window.triggerAdminLogout = function(e) {
    if (e) e.preventDefault();
    const sidebar = document.getElementById("profileSidebar");
    const overlay = document.getElementById("profileOverlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.add("hidden");

    showAdminDialog({
        title: 'Log Out',
        message: 'Are you sure you want to log out of the Admin portal?',
        btnText: 'Log Out',
        btnClass: 'btn-danger',
        onConfirm: async () => {
            if (typeof vibrate === "function") vibrate([50]);
            try {
                await window.StallzAuth?.signOut?.();
                localStorage.removeItem("stallz_last_active");
                localStorage.removeItem("stallz_test_session");
                showToast("Logged out successfully.", "success");
                setTimeout(() => window.location.replace("../index.html"), 600);
            } catch(error) {
                showToast("Failed to log out. Check connection.", "error");
            }
        }
    });
};

function init() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'new_loan') {
    setTimeout(() => document.getElementById("openLoanModalBtn")?.click(), 600);
    switchOverviewTab('dashboard');
  } else {
    setTimeout(() => switchOverviewTab('dashboard'), 100);
  }

  document.getElementById("profileToggleBtn")?.addEventListener("click", toggleProfileSidebar);
  document.getElementById("closeProfileBtn")?.addEventListener("click", toggleProfileSidebar);
  document.getElementById("profileOverlay")?.addEventListener("click", toggleProfileSidebar);
  document.getElementById("notifBtn")?.addEventListener("click", toggleNotifications);

  document.getElementById("themeToggle")?.addEventListener("change", (e) => {
    localStorage.setItem("stallz_theme_preference", e.target.checked ? "dark" : "light");
    checkTimeBasedTheme();
  });

  const lastActive = localStorage.getItem("stallz_last_active");
  if (lastActive && (Date.now() - lastActive > 30 * 60 * 1000)) {
    window.StallzAuth?.signOut?.();
    localStorage.removeItem("stallz_last_active");
    location.replace("../index.html");
    return;
  }

  document.getElementById("openLoanModalBtn")?.addEventListener("click", () => {
    if (!state.dataLoaded && !OFFLINE_TEST_MODE) return showToast("Please wait, loading data...", "error");
    vibrate([10]);
    wizardStep = 0;
    wizardDraft = {};
    updateWizard();
    const lm = document.getElementById("loanModal");
    lm.style.display = "flex";
    setTimeout(() => lm?.classList.remove("modal-hidden"), 10);
  });

  document.getElementById("modalCloseBtn")?.addEventListener("click", () => {
      const lm = document.getElementById("loanModal");
      lm?.classList.add("modal-hidden");
      setTimeout(() => lm.style.display = "none", 300);
  });

  document.getElementById("modalNextBtn")?.addEventListener("click", () => { vibrate([10]); handleWizardNext(); });
  document.getElementById("modalBackBtn")?.addEventListener("click", () => { vibrate([10]); handleWizardBack(); });
  document.getElementById("finalConfirmBtn")?.addEventListener("click", () => { vibrate([20]); closePopup("loanConfirmationModal"); saveNewLoan(); });

  // Action Modal Confirmation Listener
  document.getElementById("actionModalConfirmBtn")?.addEventListener("click", async () => {
    vibrate([20]);
    const loan = (state.loans || []).find(l => String(l.id) === String(currentLoanId));
    if (!loan) return showToast("Loan not found.", "error");

    const updates = {};
    const now = new Date().toISOString();
    let __newRepaymentForClient = null;
    let __newRepaymentIdForClient = null;

    const applyLoanUpdates = (loanObj, updatesObj, cleanup = true) => {
      const paths = (Array.isArray(loanObj?.__loanPaths) && loanObj.__loanPaths.length) ? loanObj.__loanPaths.slice() : (loanObj?.__loanPath ? [loanObj.__loanPath] : [`loans/${loanObj.id}`]);
      const primary = loanObj?.__primaryLoanPath || loanObj?.__loanPath || paths[0];
      updatesObj[primary] = loanObj;
      if (cleanup && paths.length > 1) paths.filter(p => p && p !== primary).forEach(p => { updatesObj[p] = null; });
      loanObj.__loanPaths = paths;
      loanObj.__primaryLoanPath = primary;
    };

    const resolveClientUidFromPhone = () => {
      if (loan.clientUid) return loan.clientUid;
      const phone = String(loan.clientPhone || "").replace(/\D/g, "").replace(/^0/, "260");
      const users = window.StallzShared?.listUsers?.("client") || [];
      const match = users.find(u => String(u.phone || "").replace(/\D/g, "").replace(/^0/, "260") === phone);
      return match?.uid || null;
    };

    try { computeDerivedFields(loan); } catch(e) {}

    if (currentAction === "PAY") {
      const inputAmt = Number(document.getElementById("actAmount")?.value || 0);
      if (inputAmt <= 0) return showToast("Enter a valid payment amount.", "error");
      const safeAmt = Number(Math.min(inputAmt, Number(loan.balance || 0)).toFixed(2));
      if (safeAmt <= 0) return showToast("This loan is already fully paid.", "info");

      loan.paid = Number((Number(loan.paid || 0) + safeAmt).toFixed(2));
      loan.updatedAt = now;
      const note = String(document.getElementById("actNote")?.value || "").trim();
      if (note) loan.notes = (loan.notes ? loan.notes + "\n" : "") + `[Payment ${now.split("T")[0]}]: ${note}`;

      try { computeDerivedFields(loan); } catch(e) {}

      const repaymentId = Date.now() + Math.floor(Math.random() * 100);
      const newRepayment = { id: repaymentId, loanId: loan.id, amount: safeAmt, date: document.getElementById("actDate")?.value || now.split("T")[0], recordedBy: state.user?.email || "Admin", note: note, createdAt: now };

      state.repayments.unshift(newRepayment);
      __newRepaymentForClient = { ...newRepayment };
      __newRepaymentIdForClient = repaymentId;

      const uid = resolveClientUidFromPhone();
      if (uid) {
          const notifId = "n_" + Date.now();
          const isFull = loan.balance <= 0.01;
          updates[`clients/${uid}/notifications/${notifId}`] = { id: notifId, title: isFull ? "🎉 Loan Fully Paid!" : "💰 Payment Received", body: isFull ? `Congratulations! Your loan of K${loan.amount} is fully settled.` : `We received your payment of K${safeAmt}. Remaining balance: K${loan.balance}`, read: false, createdAt: now, type: "PAYMENT" };
      }

      applyLoanUpdates(loan, updates, true);
      updates[`repayments/${repaymentId}`] = newRepayment;

    } else if (currentAction === "NOTE") {
      const newNote = String(document.getElementById("actNote")?.value || "").trim();
      if (!newNote) return showToast("Write a note first.", "error");

      // Stamp it with the Date and the Admin's Name
      const adminName = state.currentUserProfile?.name?.split(' ')[0] || state.user?.email?.split('@')[0] || "Admin";
      const timestamp = new Date().toLocaleDateString('en-ZM', {day:'numeric', month:'short'}) + " " + new Date().toLocaleTimeString('en-ZM', {hour:'2-digit', minute:'2-digit'});
      const formattedEntry = `[${timestamp} - ${adminName}]: ${newNote}`;

      // Append it to the history instead of overwriting
      loan.notes = loan.notes ? (loan.notes + "\n\n" + formattedEntry) : formattedEntry;
      loan.updatedAt = now;

      try { computeDerivedFields(loan); } catch(e) {}
      applyLoanUpdates(loan, updates, true);

    } else if (currentAction === "WRITEOFF") {
      const reason = String(document.getElementById("actNote")?.value || "").trim();
      if (!reason) return showToast("Please enter a reason for the write-off.", "error");
      loan.isDefaulted = true; loan.status = "DEFAULTED"; loan.notes = (loan.notes ? loan.notes + "\n" : "") + "[Write-Off]: " + reason; loan.updatedAt = now;
      try { computeDerivedFields(loan); } catch(e) {}
      applyLoanUpdates(loan, updates, true);
    }

    if (Object.keys(updates).length === 0) return showToast("Nothing to save.", "error");

    if (!OFFLINE_TEST_MODE && dataRef) {
      try {
        await dataRef.update(updates);
        if (window.StallzShared?.syncAdminSnapshot) window.StallzShared.syncAdminSnapshot(state.loans);
        const uid = resolveClientUidFromPhone();
        if (uid) {
          loan.clientUid = uid;
          try { await syncSingleLoanToClient(loan); } catch(e) {}
          if (currentAction === "PAY" && __newRepaymentForClient) {
            const repUpdates = {};
            repUpdates[`clients/${uid}/repayments/${__newRepaymentIdForClient}`] = __newRepaymentForClient;
            await firebase.database().ref().update(repUpdates).catch(()=>{});
          }
        }
        showToast(currentAction === "PAY" ? "Payment recorded!" : "Update successful!", "success");
      } catch (e) { showToast("Save Failed", "error"); }
    } else {
      saveState(); showToast("Saved locally", "success");
    }
    refreshUI();
    if (window.closeActionModal) window.closeActionModal();
  });

  document.getElementById("actionModalCloseBtn")?.addEventListener("click", window.closeActionModal);
  document.getElementById("actionModalCancelBtn")?.addEventListener("click", window.closeActionModal);

  document.querySelectorAll('.mini-tab[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      vibrate([10]);
      const group = btn.closest('.mini-tabs') || document;
      group.querySelectorAll('.mini-tab[data-target]').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const scope = btn.closest('.card') || document;
      scope.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      const targetContent = document.getElementById(btn.dataset.target);
      if (targetContent) targetContent.classList.add('active');
    });
  });

  document.getElementById("setStartingCapitalBtn")?.addEventListener("click", async () => {
    const inputField = document.getElementById("startingCapitalInitial");
    const val = Number(inputField?.value);
    if (val > 0) {
      state.startingCapital = val;
      const date = new Date().toISOString();
      state.startingCapitalSetDate = date;
      refreshUI();
      if (!OFFLINE_TEST_MODE && dataRef) {
          try {
              await dataRef.update({ startingCapital: val, startingCapitalSetDate: date, lastWrite: firebase.database.ServerValue.TIMESTAMP });
              showToast("Starting capital saved!", "success");
          } catch(e) { showToast("Save failed", "error"); }
      }
      inputField.value = "";
    }
  });

  document.getElementById("addCapitalBtn")?.addEventListener("click", async () => {
      const input = document.getElementById("addCapitalInput");
      const val = Number(input.value);
      if (val <= 0) return showToast("Enter a valid positive amount", "error");
      const newId = Date.now() + Math.floor(Math.random() * 1000);
      let recorderName = state.currentUserProfile?.name || state.user?.email?.split('@')[0] || "Admin";
      const newTxn = { id: newId, amount: val, date: new Date().toISOString(), note: "Manual Add", recordedBy: recorderName };
      if (!state.capitalTxns) state.capitalTxns = [];
      state.capitalTxns.unshift(newTxn);
      input.value = "";
      refreshUI();
      if (!OFFLINE_TEST_MODE && dataRef) {
          try { await dataRef.child("capitalTxns").child(String(newId)).set(newTxn); showToast("Capital added successfully!", "success"); } catch(e) { showToast("Save failed", "error"); }
      } else {
          saveState(); showToast("Capital added (Local)", "success");
      }
  });

  document.getElementById("searchInput")?.addEventListener("input", debounce(renderLoansTable, 300));
  ["statusFilter", "planFilter"].forEach(id => document.getElementById(id)?.addEventListener("input", renderLoansTable));

  document.getElementById("exportBtn")?.addEventListener("click", () => {
    if (typeof window.XLSX === "undefined") return showToast("Export library missing", "error");
    vibrate([20]);
    try {
      const data = state.loans.map(l => ({ ID: l.id, Client: l.clientName, Amount: l.amount, Balance: l.balance, Status: l.status }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Loans");
      XLSX.writeFile(wb, "Stallz_Loans.xlsx");
    } catch (e) { console.error(e); }
  });

  ensureAdminAccess().then((ok) => {
    if (!ok) return;
    try {
      window.StallzShared?.ensureSeed?.();
      window.StallzShared?.subscribe?.(() => {
        __suppressSharedSync = true;
        try { refreshUI(); } finally { __suppressSharedSync = false; }
      });
    } catch(e) {}
  });

  setInterval(() => { if (state.isLoggedIn && !__suppressSharedSync) refreshUI(); }, 15000);

  checkTimeBasedTheme();
  checkAppVersion();
  setupMobileUX();

  const _dd = document.getElementById("notifDropdown");
  const _list = document.getElementById("notifList");
  if (_dd && _list && !_list.dataset.clickwired) {
    _list.dataset.clickwired = "1";
    _list.addEventListener("click", (e) => { if (e.target.closest(".notif-item")) _dd.classList.remove("show"); }, true);
  }

  try {
    const v = (window.STALLZ_APP_VERSION || APP_VERSION || "0");
    const elV = document.getElementById("stallzVersionInline");
    if (elV) elV.textContent = "v" + String(v);
  } catch(e){}

  try {
    const search = document.getElementById("loanHistorySearchInput");
    if (search && !search.__stallzBound) {
      search.__stallzBound = true;
      search.addEventListener("input", (e) => { state.loanHistorySearch = String(e.target.value || ""); renderLoanHistory(); });
    }
  } catch(e){}

  setTimeout(() => { if (typeof runSmartEngagementEngine === 'function') runSmartEngagementEngine(); }, 8000);
}

document.addEventListener("DOMContentLoaded", init);
/* ============================================================================
 * 12.0 | SHARED SYSTEM WIRING (Client ↔ Admin)
 * ============================================================================ */

let __activeLoanRequestId = null;
let __activeClientUidForMsg = null;

window.openLoanRequestModal = function(requestId) {
  try {
    const m = document.getElementById("loanRequestModal");
    const body = document.getElementById("loanRequestBody");
    if (!m || !body) return;

    // Force display flex to override the inline 'display: none' from HTML
    m.style.display = "flex";

    // THE FIX: First check active requests, then fallback to the historical log cache
    let req = window.StallzShared?.getLoanRequest?.(requestId);
    if (!req && typeof __allRequestsCache !== 'undefined') {
        req = __allRequestsCache.find(r => String(r.id) === String(requestId));
    }

    if (!req) {
      showToast("Request not found", "error");
      return;
    }

    __activeLoanRequestId = requestId;

    const formattedPhone = req.clientPhone ? formatZambianPhone(req.clientPhone) : "-";

    body.innerHTML = `
      <div style="display:grid; gap:12px; font-size: 0.9rem;">
        <div style="padding-bottom: 8px; border-bottom: 1px solid var(--border);">
            <div style="font-weight:800; color: var(--primary); margin-bottom: 4px;">CLIENT IDENTITY</div>
            <div><strong>Full Name:</strong> ${escapeHTML(req.clientName || "Client")}</div>
            <div><strong>NRC Number:</strong> ${escapeHTML(req.nrcNumber || req.nrc || "-")}</div>
            <div><strong>Address:</strong> ${escapeHTML(req.address || "-")}</div>
        </div>

        <div style="padding-bottom: 8px; border-bottom: 1px solid var(--border);">
            <div style="font-weight:800; color: var(--primary); margin-bottom: 4px;">CONTACT DETAILS</div>
            <div><strong>Phone:</strong> ${escapeHTML(formattedPhone)}</div>
            <div><strong>Email:</strong> ${escapeHTML(req.clientEmail || "-")}</div>
        </div>

        <div>
            <div style="font-weight:800; color: var(--primary); margin-bottom: 4px;">LOAN REQUEST</div>
            <div><strong>Requested Amount:</strong> ${formatMoney(req.amount || 0)}</div>
            <div><strong>Plan:</strong> ${escapeHTML(req.plan || "-")}</div>
            <div><strong>Collateral:</strong> ${escapeHTML(req.collateralItem || "-")}</div>
            <div><strong>Collateral Value:</strong> ${formatMoney(req.collateralValue || 0)}</div>
        </div>

        ${(req.nrcFrontUrl || req.nrcBackUrl) ? `
          <div style="display:grid; gap:8px; padding-top:6px;">
            <div style="font-weight:800;">NRC DOCUMENTATION</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div>
                <div style="opacity:0.75; font-size:0.75rem; margin-bottom:4px;">Front</div>
                ${req.nrcFrontUrl ? `<a href="${req.nrcFrontUrl}" target="_blank"><img src="${req.nrcFrontUrl}" style="width:100%; border-radius:8px; border:1px solid var(--border);" /></a>` : `<div>-</div>`}
              </div>
              <div>
                <div style="opacity:0.75; font-size:0.75rem; margin-bottom:4px;">Back</div>
                ${req.nrcBackUrl ? `<a href="${req.nrcBackUrl}" target="_blank"><img src="${req.nrcBackUrl}" style="width:100%; border-radius:8px; border:1px solid var(--border);" /></a>` : `<div>-</div>`}
              </div>
            </div>
          </div>
        ` : ``}

        <div style="font-style: italic; opacity: 0.8; font-size: 0.8rem; margin-top: 5px;">
            Requested on: ${formatDate(req.createdAt)}
        </div>
      </div>
    `;
    m.classList.remove("modal-hidden");
  } catch(e) {
    console.error("Error opening loan request:", e);
  }
}

window.closeLoanRequestModal = function(){
  const m = document.getElementById("loanRequestModal");
  if (m) {
      m.classList.add("modal-hidden");
      // FIX: Re-apply display none to ensure it stays hidden
      setTimeout(() => { m.style.display = "none"; }, 300);
  }
  __activeLoanRequestId = null;
}


window.approveLoanRequest = async function(){
  if (!__activeLoanRequestId) return;

  // ⚡ FIX 1: Cache the ID and instantly clear the global variable to prevent double-clicks
  const processingId = __activeLoanRequestId;
  __activeLoanRequestId = null;

  try {
    const sess = window.StallzAuth?.getSession?.();
    const req = window.StallzShared?.getLoanRequest?.(String(processingId));

    if (!req) {
      showToast("Request not found. Refresh and try again.", "error");
      return;
    }

    // 1) Mark request approved + notify client
    await window.StallzShared?.approveLoanRequest?.(
      sess?.uid || 'admin',
      String(req.id)
    );

    // 2) Create a real loan record
    const newId = Date.now();

    // ⚡ Robustly grab the UID (Handles cases where it's stored as 'uid' instead of 'clientUid')
    let exactUid = req.clientUid || req.uid || req.userId || req.clientId || null;

    // Failsafe: If UID is still missing, try to match by phone number
    if (!exactUid && req.clientPhone) {
        const cleanPhone = String(req.clientPhone).replace(/\D/g, "").replace(/^0/, "260");
        const users = window.StallzShared?.listUsers?.("client") || [];
        const match = users.find(u => String(u.phone).replace(/\D/g, "").replace(/^0/, "260") === cleanPhone);
        if (match && match.uid) exactUid = match.uid;
    }

    const profile = window.StallzShared?.getUser?.(exactUid) || {};

    // ⚡ FIX 2: Track who approved this loan for Commission & Admin Profile stats
    let creatorName = "Admin";
    let creatorEmail = "system@stallz";
    if (state.currentUserProfile) {
        creatorName = state.currentUserProfile.name || state.currentUserProfile.firstname || "Admin";
        creatorEmail = state.currentUserProfile.email || "";
    } else if (state.user) {
        creatorEmail = state.user.email;
        creatorName = state.user.email.split('@')[0].toUpperCase();
    }

    const newLoan = {
      id: newId,
      clientUid: exactUid,
      clientName: String((req.clientName !== "Client" ? req.clientName : null) || profile.fullName || profile.name || profile.firstName || profile.email || "Client").trim(),
      clientPhone: String(req.clientPhone || profile.phone || "").trim(),
      amount: Number(req.amount || 0),
      plan: String(req.plan || "Weekly"),
      customInterest: null,
      collateralItem: String(req.collateralItem || "").trim(),
      collateralValue: Number(req.collateralValue || 0),
      startDate: toDateOnly(new Date()),
      status: "ACTIVE",
      notes: `Approved from request #${req.id}`,
      paid: 0,
      saleAmount: 0,
      profitCollected: 0,
      isDefaulted: false,
      requestId: req.id,
      createdBy: creatorName,      // Ensures the admin gets credit
      createdEmail: creatorEmail,  // Ensures the admin gets credit
      createdAt: new Date().toISOString()
    };

    if (!state.loans) state.loans = [];
    state.loans.unshift(newLoan);
    computeDerivedFields(newLoan);

    if (!OFFLINE_TEST_MODE && dataRef) {
      // ATOMIC multi-path write
      const rootUpdates = {};
      rootUpdates[`loanManagerData_v5/loans/${newId}`] = newLoan;

      // ⚡ Push to client's secure node using the robust UID
      if (newLoan.clientUid) {
        rootUpdates[`clients/${newLoan.clientUid}/loans/${newId}`] = newLoan;

        // 🟢 NEW: APPROVAL NOTIFICATION TRIGGER
        const notifId = "n_" + Date.now();
        rootUpdates[`clients/${newLoan.clientUid}/notifications/${notifId}`] = {
            id: notifId,
            title: "✅ Loan Approved",
            body: `Your loan request for K${newLoan.amount} has been approved. Check your dashboard for details.`,
            read: false,
            createdAt: new Date().toISOString(),
            type: "APPROVAL"
        };
      }

      await firebase.database().ref().update(rootUpdates);

      try { window.StallzShared?.syncAdminSnapshot?.(state.loans || []); } catch(e) {}
    } else {
      saveState();
    }

    showToast("Approved ✅ Loan created & client updated.", "success");
    window.closeLoanRequestModal();
    refreshUI();
  } catch(e){
    console.error(e);
    showToast("Approve failed", "error");
    // Restore the ID so the admin can try clicking the button again if their internet dropped
    __activeLoanRequestId = processingId;
  }
}

window.rejectLoanRequest = async function(){
  if (!__activeLoanRequestId) return;

  // Find the user's UID so we know whose phone to ping
  const req = window.StallzShared?.getLoanRequest?.(String(__activeLoanRequestId));
  const uid = req ? (req.clientUid || req.uid || req.userId) : null;

  showAdminDialog({
      title: 'Decline Loan',
      message: 'Please provide a reason for declining this request:',
      isPrompt: true,
      placeholder: 'E.g., Incomplete details, unpaid balance...',
      btnText: 'Decline Request',
      btnClass: 'btn-danger',
      onConfirm: async (reason) => {
          try {
            const sess = window.StallzAuth?.getSession?.();
            await window.StallzShared?.rejectLoanRequest?.(
                sess?.uid || 'admin',
                String(__activeLoanRequestId),
                String(reason).trim()
            );

            // 🟢 NEW: REJECTION NOTIFICATION TRIGGER
            if (uid) {
                const notifId = "n_" + Date.now();
                await firebase.database().ref(`clients/${uid}/notifications/${notifId}`).set({
                    id: notifId,
                    title: "❌ Loan Declined",
                    body: `Reason: ${reason.trim()}`,
                    read: false,
                    createdAt: new Date().toISOString(),
                    type: "REJECTION"
                });
            }

            showToast("Request rejected & Client notified.", "success");
            window.closeLoanRequestModal();
            refreshUI();
          } catch(e){
            console.error(e);
            showToast("Reject failed", "error");
          }
      }
  });
}

window.openAdminMessageModal = function(clientUid){
  try {
    if (!clientUid) return;
    __activeClientUidForMsg = clientUid;
    const m = document.getElementById("adminMessageModal");
    const title = document.getElementById("adminMessageTitle");
    const thread = document.getElementById("adminMessageThread");

    if (!m || !thread) return;

    // FIX: Force display flex to override the inline 'display: none'
    m.style.display = "flex";
    m.classList.remove("modal-hidden");

    const u = window.StallzShared?.getUser?.(clientUid);
    title.textContent = u ? `Message: ${u.name || u.email || "Client"}` : "Message Client";
    renderAdminMessageThread();

  } catch(e){ console.error(e); }
}

window.closeAdminMessageModal = function(){
  const m = document.getElementById("adminMessageModal");
  if (m) {
      m.classList.add("modal-hidden");
      // FIX: Re-apply display none to ensure it stays hidden
      setTimeout(() => { m.style.display = "none"; }, 300);
  }
  __activeClientUidForMsg = null;
}

function renderAdminMessageThread(){
  const thread = document.getElementById("adminMessageThread");
  if (!thread || !__activeClientUidForMsg) return;
  const msgs = window.StallzShared?.getMessages?.(__activeClientUidForMsg) || [];
  if (!msgs.length) {
    thread.innerHTML = `<div style="opacity:0.7; text-align:center; padding:16px;">No messages yet.</div>`;
    return;
  }
  thread.innerHTML = msgs.map(m => {
    const isAdmin = m.fromRole === "admin";
    return `
      <div style="display:flex; justify-content:${isAdmin ? "flex-end" : "flex-start"}; margin:8px 0;">
        <div style="max-width:80%; padding:10px 12px; border-radius:14px; border:1px solid var(--border);
          background:${isAdmin ? "rgba(34,197,94,0.12)" : "rgba(59,130,246,0.12)"};">
          <div style="font-weight:700; font-size:0.8rem; margin-bottom:4px;">${isAdmin ? "Admin" : "Client"}</div>
          <div style="white-space:pre-wrap;">${escapeHTML(m.text || "")}</div>
          <div style="opacity:0.6; font-size:0.75rem; margin-top:6px;">${new Date(m.createdAt).toLocaleString()}</div>
        </div>
      </div>
    `;
  }).join("");
  thread.scrollTop = thread.scrollHeight;
}

window.sendAdminMessage = async function(){
  const input = document.getElementById("adminMessageInput");
  const text = (input?.value || "").trim();
  if (!text || !__activeClientUidForMsg) return;
  try {
    const sess = window.StallzAuth?.getSession?.();

    // 1. Send to chat thread
    await window.StallzShared?.sendMessage?.({
      clientUid: __activeClientUidForMsg,
      fromUid: sess?.uid || state.user?.uid || "admin",
      fromRole: "admin",
      text
    });

    // 2. 🟢 NEW: CHAT NOTIFICATION TRIGGER (Rings their phone!)
    const notifId = "n_" + Date.now();
    await firebase.database().ref(`clients/${__activeClientUidForMsg}/notifications/${notifId}`).set({
        id: notifId,
        title: "💬 New Message from Admin",
        body: text,
        read: false,
        createdAt: new Date().toISOString(),
        type: "MESSAGE"
    });

    input.value = "";
    renderAdminMessageThread();
    refreshUI();
  } catch(e){
    console.error(e);
    showToast("Message failed", "error");
  }
};

/* ============================================================================
 * SECURE SYNC: Distribute Loans to Client Folders
 * ============================================================================ */
let __lastDistribute = 0;

/**
 * Immediate secure sync for a SINGLE loan into:
 *   clients/{uid}/loans/{loanId}
 * This avoids relying on the 10s bulk-sync rate limit.
 */
function syncSingleLoanToClient(loan) {
  try {
    if (!loan || !loan.clientUid) return Promise.resolve();
    if (!dataRef || OFFLINE_TEST_MODE) return Promise.resolve();

    const updates = {};
    updates[`clients/${loan.clientUid}/loans/${loan.id}`] = loan;

    return firebase.database().ref().update(updates)
      .catch(e => console.warn("Single loan sync warning:", e));
  } catch (e) {
    console.warn("Single loan sync warning:", e);
    return Promise.resolve();
  }
}

function distributeLoansToClients(allLoans, force = false) {
  // Rate Limit: Only run this heavy sync every 10 seconds max (unless forced)
  const now = Date.now();
  if (!force && now - __lastDistribute < 10000) return;
  __lastDistribute = now;

  if (!dataRef || OFFLINE_TEST_MODE) return;

  const updates = {};
  let count = 0;

  // 1. Group loans by Client UID
  allLoans.forEach(loan => {
    if (loan.clientUid) {
      // Write to: clients/{uid}/loans/{loanId}
      // This is the ONLY place the Client is allowed to read now.
      updates[`clients/${loan.clientUid}/loans/${loan.id}`] = loan;
      count++;
    }
  });

  // 2. Perform the update if there is data
  if (count > 0) {
    // We use the root ref to update multiple client paths at once
    firebase.database().ref().update(updates)
      .catch(e => console.warn("Sync Distribute Warning:", e));
  }
}

/* ============================================================================
   13.0 | ADMIN PROFILE & COMMISSION LOGIC
   ============================================================================ */

/**
 * Calculates commission with the "Penalty Logic"
 * Standard: 20% of Profit
 * Penalty: If Actual Rate < Standard Rate, Commission drops by same %
 */
function calculateLoanCommission(loan) {
    // 1. Determine Standard Rate for this Plan
    const stdRate = INTEREST_BY_PLAN[loan.plan] || 0.40; // Default to 40% if unknown

    // 2. Determine Actual Rate Given
    const actualRate = (loan.customInterest !== undefined && loan.customInterest !== null)
                       ? (Number(loan.customInterest) / 100)
                       : stdRate;

    // 3. Calculate Profit (Interest portion of Total Due)
    const principal = Number(loan.amount || 0);
    const totalDue = Number(loan.totalDue || 0);
    const profit = Math.max(0, totalDue - principal);

    // 4. Calculate Penalty Factor
    let reductionFactor = 0;

    if (actualRate < stdRate && stdRate > 0) {
        reductionFactor = (stdRate - actualRate) / stdRate;
    }

    // 5. Calculate Final Commission Rate
    // ✅ CHANGED: Base is now 20% (0.20)
    const BASE_COMMISSION = 0.20;
    let finalCommRate = BASE_COMMISSION * (1 - reductionFactor);

    // Safety: Cap at 20% (No bonus for over-charging) and min 0%
    finalCommRate = Math.max(0, Math.min(BASE_COMMISSION, finalCommRate));

    // 6. Calculate Amount
    const commissionAmount = Number((profit * finalCommRate).toFixed(2));

    return {
        profit: profit,
        stdRate: stdRate,
        actualRate: actualRate,
        commRate: finalCommRate,
        amount: commissionAmount,
        isPenalized: reductionFactor > 0.01 // True if dropped by >1%
    };
}

window.openAdminProfile = function(identifier) {
    // 1. ✅ CLOSE SIDEBAR IMMEDIATELY
    const sidebar = document.getElementById("profileSidebar");
    const overlay = document.getElementById("profileOverlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.add("hidden");

    // 2. Find the Admin Data
    const admin = state.admins.find(a =>
        String(a.uid) === String(identifier) ||
        String(a.email) === String(identifier)
    );

    if (!admin) {
        showToast("Admin profile not found", "error");
        return;
    }

    // 3. Check Permissions (The "Prince" Exclusion)
    const nameLower = (admin.name || "").toLowerCase();
    const emailLower = (admin.email || "").toLowerCase();

    const isOwner = nameLower.includes("prince") ||
                    nameLower.includes("kasininga") ||
                    emailLower.includes("prince");

    // 4. Populate Header
    const initials = getInitials(admin.name);
    const elAvatar = document.getElementById("apAvatar");
    elAvatar.textContent = initials;
    const colorIdx = (admin.name.length) % 5;
    elAvatar.className = `avatar avatar-${colorIdx}`;

    document.getElementById("apName").textContent = admin.name;
    document.getElementById("apRole").textContent = (admin.role || "Admin").toUpperCase();
    document.getElementById("apContact").textContent = admin.email || admin.phone || "";

    // 5. Find Associated Loans
    const adminLoans = state.loans.filter(l => {
        const byName = l.createdBy && l.createdBy.toLowerCase() === nameLower;
        const byEmail = l.createdEmail && l.createdEmail.toLowerCase() === emailLower;
        const legacyNyambi = nameLower.includes("nyambi") && l.createdBy === "NYAMBI SITALEKA";

        return byName || byEmail || legacyNyambi;
    });

    // 6. Render "Activity" Tab
    document.getElementById("apLoansCount").textContent = adminLoans.length;

    const recentDiv = document.getElementById("apRecentList");
    recentDiv.innerHTML = adminLoans.slice(0, 10).map(l => `
        <div style="display:flex; justify-content:space-between; padding:10px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
            <div>
                <div style="font-size:0.85rem; font-weight:600;">${escapeHTML(l.clientName)}</div>
                <div style="font-size:0.7rem; color:var(--text-muted);">${formatDate(l.createdAt)}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:0.85rem; font-weight:700;">${formatMoney(l.amount)}</div>
                <div class="status-pill status-${l.status.toLowerCase()}" style="font-size:0.6rem; padding:2px 6px;">${l.status}</div>
            </div>
        </div>
    `).join("") || `<div style="text-align:center; opacity:0.5; padding:20px;">No loans recorded yet.</div>`;

    // 7. Handle "Commissions" Tab
    const tabBtn = document.getElementById("tabBtnCommissions");
    const tabContent = document.getElementById("ap-tab-commissions");

    if (isOwner) {
        if(tabBtn) tabBtn.style.display = "none";
        if(tabContent) tabContent.style.display = "none";
        switchProfileTab('activity');
    } else {
        if(tabBtn) tabBtn.style.display = "block";

        let totalCommission = 0;
        let weightedRateSum = 0;

        const commRows = adminLoans.map(l => {
            const c = calculateLoanCommission(l);
            totalCommission += c.amount;
            weightedRateSum += c.commRate;

            const rateDisplay = (c.commRate * 100).toFixed(1) + "%";
            const badgeClass = c.isPenalized ? "comm-cut" : "comm-full";
            const profitStr = formatMoney(c.profit);

            const rateComp = c.isPenalized
                ? `${(c.actualRate*100).toFixed(0)}% <span style="opacity:0.5">vs ${(c.stdRate*100).toFixed(0)}%</span>`
                : `<span style="opacity:0.5">Std</span> ${(c.stdRate*100).toFixed(0)}%`;

            return `
                <tr>
                    <td>
                        <div style="font-weight:600;">${escapeHTML(l.clientName)}</div>
                        <div class="rate-info">Profit: ${profitStr}</div>
                    </td>
                    <td style="text-align:right;">
                         ${formatMoney(c.amount)}
                    </td>
                    <td style="text-align:center;">
                        <div style="font-size:0.8rem;">${rateComp}</div>
                        ${c.isPenalized ? '<span style="color:#f87171; font-size:0.65rem;">Interest Cut</span>' : '<span style="color:#34d399; font-size:0.65rem;">Full 20%</span>'}
                    </td>
                    <td style="text-align:right;">
                        <span class="comm-badge ${badgeClass}">${rateDisplay}</span>
                    </td>
                </tr>
            `;
        }).join("");

        document.getElementById("apCommBody").innerHTML = commRows || `<tr><td colspan="4" style="text-align:center; padding:20px; opacity:0.5;">No commissions data.</td></tr>`;

        document.getElementById("apTotalComm").textContent = formatMoney(totalCommission);

        const avgRate = adminLoans.length > 0 ? (weightedRateSum / adminLoans.length) : 0.20;
        document.getElementById("apAvgComm").textContent = (avgRate * 100).toFixed(1) + "%";
    }

    openPopup("adminProfileModal");
};

window.switchProfileTab = function(tabName, btn) {
    document.querySelectorAll(".sketch-tabs .sketch-btn").forEach(b => b.classList.remove("active"));
    if(btn) btn.classList.add("active");
    else {
        if(tabName === 'activity') document.querySelector("button[onclick*='activity']").classList.add("active");
        if(tabName === 'commissions') document.querySelector("button[onclick*='commissions']").classList.add("active");
    }
    document.querySelectorAll(".profile-tab-content").forEach(d => d.style.display = "none");
    document.getElementById("ap-tab-" + tabName).style.display = "block";
};

/* SIDEBAR CLICK-AWAY LISTENER */
document.addEventListener("DOMContentLoaded", function() {
    const overlay = document.getElementById("profileOverlay");
    if (overlay) {
        overlay.addEventListener("click", function() {
            // Close the sidebar when the overlay is clicked
            window.toggleProfileSidebar();
        });
    }
});

/* ============================================================================
   14.0 | EXPENSE & COMMISSION MANAGEMENT (NEW)
   ============================================================================ */

// 1. Initialize Expenses in State
if (!state.expenses) state.expenses = [];


// 3. Open Expense Modal
window.openExpenseModal = function(type, prefillNote = "") {
    const m = document.getElementById("expenseModal");
    if(!m) return;

    document.getElementById("expenseModalTitle").textContent = type === 'Commission' ? "Pay Commission" : "Record Expense";
    document.getElementById("expCategory").value = type === 'Commission' ? "Commission" : "General";
    document.getElementById("expAmount").value = "";
    document.getElementById("expDate").value = new Date().toISOString().split('T')[0];
    document.getElementById("expNote").value = prefillNote;

    // Close other modals if open (like Admin Profile)
    document.getElementById("adminProfileModal").classList.add("modal-hidden");

    openPopup("expenseModal");
};

// 4. Save Expense
window.saveExpense = async function() {
    const amt = Number(document.getElementById("expAmount").value);
    const date = document.getElementById("expDate").value;
    const cat = document.getElementById("expCategory").value;
    const note = document.getElementById("expNote").value.trim();

    if(amt <= 0) { showToast("Enter a valid amount", "error"); return; }

    const newExp = {
        id: Date.now(),
        amount: amt,
        date: date,
        category: cat,
        note: note,
        recordedBy: state.user?.email || "Admin"
    };

    // Update Local State
    if(!state.expenses) state.expenses = [];
    state.expenses.unshift(newExp);

    // Save to DB
    if(!OFFLINE_TEST_MODE && dataRef) {
        await dataRef.child("expenses").child(String(newExp.id)).set(newExp);
    } else {
        saveState();
    }

    showToast("Expense Recorded!", "success");
    closePopup("expenseModal");
    refreshUI();
};

/* ============================================================================
   UPDATED DASHBOARD & CAPITAL RENDERERS
   ============================================================================ */

/* ============================================================================
   UPDATED DASHBOARD & CAPITAL RENDERERS (With Staggered Animations)
   ============================================================================ */

function renderDashboard() {
  const container = document.getElementById("dashboardStats");
  if (!container) return;

  const loans = state.loans || [];
  const expenses = state.expenses || [];

  // 1. Stats
  const totalLoaned = loans.reduce((s, l) => s + (l.amount || 0), 0);
  const totalOutstanding = loans.reduce((s, l) => {
      if (l.status === "DEFAULTED") return s;
      return s + Math.max(0, l.balance || 0);
  }, 0);
  const totalProfit = loans.reduce((s, l) => s + (l.profitCollected || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const activeCount = loans.filter(l => l.status === "ACTIVE" || l.status === "OVERDUE").length;

  // 2. Cash on Hand Formula
  const starting = state.startingCapital || 0;
  const capitalIn = (state.capitalTxns || []).reduce((s, t) => s + (t.amount || 0), 0);
  const repaymentsIn = loans.reduce((s, l) => s + (l.paid || 0), 0);

  const cashOnHand = (starting + capitalIn + repaymentsIn) - (totalLoaned + totalExpenses);

  // 3. Update Cash Display
  const cashEl = document.getElementById("cashOnHandValue");
  if (cashEl) {
    cashEl.textContent = formatMoney(cashOnHand);
    if (cashOnHand < 0) cashEl.classList.add("text-danger-glow");
    else cashEl.classList.remove("text-danger-glow");
  }

  // Update Starting Capital UI
  if (state.startingCapital > 0) {
      if (document.getElementById("startingCapitalSetupRow")) document.getElementById("startingCapitalSetupRow").style.display = "none";
      if (document.getElementById("startingCapitalValue")) document.getElementById("startingCapitalValue").textContent = formatMoney(state.startingCapital);
  } else {
      if (document.getElementById("startingCapitalSetupRow")) document.getElementById("startingCapitalSetupRow").style.display = "block";
      if (document.getElementById("startingCapitalValue")) document.getElementById("startingCapitalValue").textContent = "Not set";
  }

  // --- NEW ANIMATION LOGIC ---
  // Determine if this is the first load to prevent flashing on the 15-second auto-refresh
  const isFirstLoad = !(typeof __dashboardAnimRan !== 'undefined' && __dashboardAnimRan);
  const animClass = isFirstLoad ? "fade-in" : "";
  const getDelay = (i) => isFirstLoad ? `animation-delay: ${i * 0.12}s;` : "";

  // 4. Render Cards with Staggered Delays
  container.innerHTML = `
    <div class="stat-card ${animClass}" style="border-color: var(--primary); ${getDelay(1)}">
      <div class="stat-label">Active Deals</div>
      <div class="stat-value" style="font-size: 1.8rem;">${activeCount}</div>
      <div class="stat-sub">Clients with open balances</div>
    </div>
    <div class="stat-card stat-purple ${animClass}" style="${getDelay(2)}">
      <div class="stat-label">Total Loaned</div>
      <div class="stat-value" id="statLoaned">${isFirstLoad ? 'K0.00' : formatMoney(totalLoaned)}</div>
    </div>
    <div class="stat-card stat-orange ${animClass}" style="${getDelay(3)}">
      <div class="stat-label">Outstanding</div>
      <div class="stat-value" id="statOutstanding">${isFirstLoad ? 'K0.00' : formatMoney(totalOutstanding)}</div>
      <div class="stat-sub">Expected Collection</div>
    </div>
    <div class="stat-card stat-green ${animClass}" style="${getDelay(4)}">
      <div class="stat-label">Net Profit</div>
      <div class="stat-value" id="statProfit">${isFirstLoad ? 'K0.00' : formatMoney(totalProfit)}</div>
      <div class="stat-sub">Interest Collected</div>
    </div>
    <div class="stat-card ${animClass}" style="border-color:#ef4444; background:rgba(239, 68, 68, 0.05); ${getDelay(5)}">
      <div class="stat-label" style="color:#ef4444;">Expenses</div>
      <div class="stat-value" id="statExpenses" style="color:#ef4444;">${isFirstLoad ? 'K0.00' : formatMoney(totalExpenses)}</div>
      <div class="stat-sub">Commissions & Costs</div>
    </div>
  `;

  // 5. Trigger Number Counting Animation
  if (isFirstLoad) {
      animateValue(document.getElementById("statLoaned"), 0, totalLoaned, 1500);
      animateValue(document.getElementById("statOutstanding"), 0, totalOutstanding, 2000);
      animateValue(document.getElementById("statProfit"), 0, totalProfit, 2500);
      animateValue(document.getElementById("statExpenses"), 0, totalExpenses, 3000);
      __dashboardAnimRan = true; // Mark as run so it doesn't loop forever
  }
}

/* ============================================================================
   13.0 | ADMIN PROFILE & COMMISSION LOGIC (Final: 25% + Policy Note + Aligned)
   ============================================================================ */

/**
 * Calculates commission with the "Penalty Logic"
 * Standard: 25% of Profit
 * Penalty: If Actual Rate < Standard Rate, Commission drops by same %
 */
function calculateLoanCommission(loan) {
    // 1. Determine Standard Rate for this Plan
    const stdRate = INTEREST_BY_PLAN[loan.plan] || 0.40; // Default to 40% if unknown

    // 2. Determine Actual Rate Given
    const actualRate = (loan.customInterest !== undefined && loan.customInterest !== null)
                        ? (Number(loan.customInterest) / 100)
                        : stdRate;

    // 3. Calculate Profit (Interest portion of Total Due)
    const principal = Number(loan.amount || 0);
    const totalDue = Number(loan.totalDue || 0);
    const profit = Math.max(0, totalDue - principal);

    // 4. Calculate Penalty Factor
    let reductionFactor = 0;

    // Only apply penalty if rate was actually cut (ignore small rounding diffs)
    if (actualRate < (stdRate - 0.01) && stdRate > 0) {
        reductionFactor = (stdRate - actualRate) / stdRate;
    }

    // 5. Calculate Final Commission Rate
    // ✅ BASE: 25% (0.25)
    const BASE_COMMISSION = 0.25;
    let finalCommRate = BASE_COMMISSION * (1 - reductionFactor);

    // Safety: Cap at 25% and min 0%
    finalCommRate = Math.max(0, Math.min(BASE_COMMISSION, finalCommRate));

    // 6. Calculate Amount
    const commissionAmount = profit * finalCommRate;

    return {
        profit: profit,
        stdRate: stdRate,
        actualRate: actualRate,
        commRate: finalCommRate,
        amount: commissionAmount,
        isPenalized: reductionFactor > 0.01
    };
}

window.openAdminProfile = function(identifier) {
    // 1. Force Sidebar to Close
    const sidebar = document.getElementById("profileSidebar");
    const overlay = document.getElementById("profileOverlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.add("hidden");

    // 2. Find the Admin Data
    const admin = state.admins.find(a =>
        String(a.uid) === String(identifier) ||
        String(a.email) === String(identifier)
    );

    if (!admin) {
        showToast("Admin profile not found", "error");
        return;
    }

    // 3. Check Permissions
    const nameLower = (admin.name || "").toLowerCase();
    const isOwner = nameLower.includes("prince") || nameLower.includes("kasininga");

    // 4. Populate Header
    const initials = getInitials(admin.name);
    const elAvatar = document.getElementById("apAvatar");
    elAvatar.textContent = initials;
    const colorIdx = (admin.name.length) % 5;
    elAvatar.className = `avatar avatar-${colorIdx}`;
    elAvatar.style.width = "80px";
    elAvatar.style.height = "80px";
    elAvatar.style.fontSize = "2rem";
    elAvatar.style.margin = "0 auto 12px auto";

    document.getElementById("apName").textContent = admin.name;
    document.getElementById("apRole").textContent = (admin.role || "Admin").toUpperCase();
    document.getElementById("apContact").textContent = admin.email || admin.phone || "";

    // 5. Find Associated Loans
    const adminLoans = state.loans.filter(l => {
        const creator = (l.createdBy || "").toLowerCase();
        return creator === nameLower || (nameLower.includes("nyambi") && creator === "nyambi sitaleka");
    });

    // 6. Render "Activity" Tab (Recent Loans)
    document.getElementById("apLoansCount").textContent = adminLoans.length;
    const recentDiv = document.getElementById("apRecentList");
    const sortedLoans = [...adminLoans].sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));

    if (sortedLoans.length === 0) {
        recentDiv.innerHTML = `<div style="text-align:center; opacity:0.5; padding:20px;">No loans recorded yet.</div>`;
    } else {
        recentDiv.innerHTML = sortedLoans.slice(0, 10).map(l => `
            <div style="display:flex; justify-content:space-between; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px; border:1px solid rgba(255,255,255,0.05); align-items:center; margin-bottom:6px;">
                <div>
                    <div style="font-size:0.9rem; font-weight:600;">${escapeHTML(l.clientName)}</div>
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${formatDate(l.startDate)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.9rem; font-weight:700;">${formatMoney(l.amount)}</div>
                    <span class="status-pill status-${l.status.toLowerCase()}" style="font-size:0.65rem; padding:2px 8px; margin-top:4px; display:inline-block;">${l.status}</span>
                </div>
            </div>
        `).join("");
    }

    // 7. Handle "Commissions" Tab
    const tabBtn = document.getElementById("tabBtnCommissions");
    const tabContent = document.getElementById("ap-tab-commissions");

    if (isOwner) {
        if(tabBtn) tabBtn.style.display = "none";
        if(tabContent) tabContent.style.display = "none";
        switchProfileTab('activity');
    } else {
        if(tabBtn) tabBtn.style.display = "block";

        // A. Calculate Financials
        let totalEarned = 0;
        let weightedRateSum = 0;

        const commissionRows = adminLoans.map(l => {
            const c = calculateLoanCommission(l);
            totalEarned += c.amount;
            weightedRateSum += c.commRate;
            return { loan: l, ...c };
        });

        const paidComm = (state.expenses || [])
            .filter(e => e.category === 'Commission' && e.note.toLowerCase().includes(nameLower))
            .reduce((s, e) => s + e.amount, 0);

        const pendingComm = Math.max(0, totalEarned - paidComm);

        // B. Render Layout
        // 1. Summary Card
        let html = `
            <div style="background:linear-gradient(145deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)); padding:20px; border-radius:16px; margin-bottom:20px; border:1px solid rgba(255,255,255,0.1);">
                <div style="display:flex; justify-content:space-between; margin-bottom:15px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px;">
                    <div>
                        <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; margin-bottom:4px;">Total Earned</div>
                        <div style="font-size:1.1rem; font-weight:700; color:#34d399;">${formatMoney(totalEarned)}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; margin-bottom:4px;">Total Paid</div>
                        <div style="font-size:1.1rem; font-weight:700; color:#93c5fd;">${formatMoney(paidComm)}</div>
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <div>
                        <div style="font-size:0.8rem; font-weight:600; color:#fff;">Pending Payout</div>
                        <div style="font-size:0.75rem; color:#94a3b8;">Available to withdraw</div>
                    </div>
                    <div style="font-size:1.4rem; font-weight:800; color:#facc15;">${formatMoney(pendingComm)}</div>
                </div>

                <button onclick="openExpenseModal('Commission', 'Commission Payment for ${escapeHTML(admin.name)}')"
                    style="width:100%; background:#facc15; color:#000; border:none; padding:12px; border-radius:10px; font-weight:700; font-size:0.95rem; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 4px 15px rgba(250, 204, 21, 0.2);">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                    Pay Commission
                </button>
            </div>
        `;

        // 2. Policy Notice (Restored!)
        html += `
            <div style="background:rgba(59, 130, 246, 0.1); border:1px solid rgba(59, 130, 246, 0.2); padding:12px; border-radius:12px; font-size:0.75rem; color:#93c5fd; margin-bottom:20px; line-height:1.4;">
                <strong>ℹ️ Policy:</strong> Standard commission is 25% of profit. If the loan interest rate is discounted, the commission % is reduced by the same proportion.
            </div>
        `;

        // 3. Detailed Table
        html += `
            <div style="background:rgba(255,255,255,0.02); border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,0.05);">
                <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
                    <thead>
                        <tr style="background:rgba(255,255,255,0.05); text-align:left;">
                            <th style="padding:12px 15px; color:#94a3b8; font-size:0.75rem; text-transform:uppercase;">Loan Details</th>
                            <th style="padding:12px 10px; text-align:right; color:#94a3b8; font-size:0.75rem; text-transform:uppercase;">Loan Profit</th>
                            <th style="padding:12px 10px; text-align:center; color:#94a3b8; font-size:0.75rem; text-transform:uppercase;">Your Cut</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        if (commissionRows.length === 0) {
            html += `<tr><td colspan="3" style="text-align:center; padding:30px; opacity:0.5; font-style:italic;">No commission history found.</td></tr>`;
        } else {
            // Sort by Date Descending
            commissionRows.sort((a,b) => new Date(b.loan.startDate) - new Date(a.loan.startDate));

            html += commissionRows.map(row => {
                const profitStr = formatMoney(row.profit);
                const commStr = formatMoney(row.amount);

                // Badge Logic
                let badgeHtml = '';
                if (row.isPenalized) {
                    badgeHtml = `
                        <div style="margin-top:4px; display:flex; justify-content:flex-end;">
                            <span style="background:rgba(239, 68, 68, 0.15); color:#f87171; border:1px solid rgba(239, 68, 68, 0.2); padding:2px 6px; border-radius:4px; font-size:0.65rem; font-weight:700;">
                                ⚠️ Interest Cut
                            </span>
                            <span style="font-size:0.7rem; color:#94a3b8; margin-left:4px;">(${(row.commRate*100).toFixed(0)}%)</span>
                        </div>
                    `;
                } else {
                    badgeHtml = `
                        <div style="margin-top:4px; display:flex; justify-content:flex-end; text-align:right;">
                            <span style="background:rgba(52, 211, 153, 0.15); color:#34d399; border:1px solid rgba(52, 211, 153, 0.2); padding:2px 6px; border-radius:4px; font-size:0.65rem; font-weight:700;">
                                ✔️ 25% Std
                            </span>
                        </div>
                    `;
                }

                return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:12px 15px;">
                        <div style="font-weight:700; color:var(--text-main);">${escapeHTML(row.loan.clientName)}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                           ${formatDate(row.loan.startDate)}
                        </div>
                    </td>
                    <td style="padding:12px 10px; text-align:right;">
                        <div style="font-weight:600; opacity:0.9;">${profitStr}</div>
                        <div style="font-size:0.90rem; color:#94a3b8; text-align:left;">Generated profit</div>
                    </td>
                    <td style="padding:12px 10px; text-align:left;">
                        <div style="font-weight:800; color:#34d399; font-size:0.95rem;">+${commStr}</div>
                        ${badgeHtml}
                    </td>
                </tr>`;
            }).join("");
        }

        html += `</tbody></table></div>`;

        // Update Header Stats
        if(document.getElementById("apTotalComm")) document.getElementById("apTotalComm").textContent = formatMoney(totalEarned);
        if(document.getElementById("apAvgComm")) {
             const avgRate = adminLoans.length > 0 ? (weightedRateSum / adminLoans.length) : 0.25;
             document.getElementById("apAvgComm").textContent = (avgRate * 100).toFixed(1) + "%";
        }

        // Inject Content
        tabContent.innerHTML = html;
    }

    openPopup("adminProfileModal");
};

window.switchProfileTab = function(tabName, btn) {
    document.querySelectorAll(".sketch-tabs .sketch-btn").forEach(b => b.classList.remove("active"));
    if(btn) btn.classList.add("active");
    else {
        if(tabName === 'activity') document.querySelector("button[onclick*='activity']")?.classList.add("active");
        if(tabName === 'commissions') document.querySelector("button[onclick*='commissions']")?.classList.add("active");
    }
    document.querySelectorAll(".profile-tab-content").forEach(d => d.style.display = "none");
    document.getElementById("ap-tab-" + tabName).style.display = "block";
};

// ============================================================================
// PAYMENT METHODS MANAGEMENT (Admin Side)
// ============================================================================

window.openPaymentMethodsModal = function() {
    openPopup('paymentMethodsModal');
    fetchAndRenderAdminPaymentMethods();
};

window.fetchAndRenderAdminPaymentMethods = async function() {
    const tbody = document.getElementById("paymentMethodsBody");
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        // Fetch from the root paymentMethods node
        const snapshot = await firebase.database().ref('paymentMethods').once('value');
        const methods = snapshot.val() || {};
        const keys = Object.keys(methods);

        if (keys.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-muted); font-style:italic;">No numbers set up yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = keys.map(key => {
            const m = methods[key];
            return `
            <tr>
                <td style="font-weight:600;">${escapeHTML(m.name)}</td>
                <td style="font-family:monospace; color:var(--primary); font-weight:600;">${escapeHTML(m.phone)}</td>
                <td style="text-align:right;">
                    <button class="btn-icon" style="color:#ef4444; background:rgba(239, 68, 68, 0.1); padding:6px 12px; border-radius:6px; font-size: 0.75rem; font-weight: 700;" onclick="deletePaymentMethod('${key}')">Delete</button>
                </td>
            </tr>
            `;
        }).join("");
    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#ef4444;">Failed to load.</td></tr>`;
    }
};

window.addPaymentMethod = async function() {
    const nameEl = document.getElementById("pmName");
    const phoneEl = document.getElementById("pmPhone");
    const name = nameEl.value.trim().toUpperCase();
    const phone = phoneEl.value.trim();

    if (!name || !phone) {
        showToast("Please enter both an account name and a phone number.", "error");
        return;
    }

    // Generate a unique key
    const key = "pm_" + Date.now();
    const newMethod = { name, phone };

    try {
        await firebase.database().ref(`paymentMethods/${key}`).set(newMethod);
        showToast("Payment method added!", "success");
        nameEl.value = "";
        phoneEl.value = "";
        fetchAndRenderAdminPaymentMethods(); // Refresh the list
    } catch (e) {
        showToast("Failed to save.", "error");
    }
};

window.deletePaymentMethod = function(key) {
    showAdminDialog({
        title: 'Delete Number',
        message: 'Are you sure you want to remove this payment number from the Client Portal?',
        btnText: 'Delete',
        btnClass: 'btn-danger',
        onConfirm: async () => {
            try {
                await firebase.database().ref(`paymentMethods/${key}`).remove();
                showToast("Payment method removed", "success");
                fetchAndRenderAdminPaymentMethods(); // Refresh the list
            } catch (e) {
                showToast("Failed to remove", "error");
            }
        }
    });
};

window.confirmAdminDialog = function() {
    const inputEl = document.getElementById('adminDialogInput');
    const val = inputEl.style.display === 'block' ? inputEl.value : null;

    if (inputEl.style.display === 'block' && !String(val).trim()) {
        showToast("This field is required", "error");
        if(typeof vibrate === "function") vibrate([50]);
        return;
    }

    const callbackToRun = __adminDialogCallback; // 1. Save the command FIRST
    closeAdminDialog();                          // 2. Close the window
    if (typeof callbackToRun === 'function') callbackToRun(val); // 3. Run the command
};

// ============================================================================
// ALL LOAN REQUESTS MANAGEMENT (Admin Side Log)
// ============================================================================
let __allRequestsCache = [];
let __requestsFilter = 'ALL';

window.openAllRequestsModal = function() {
    openPopup('allRequestsModal');
    fetchAndRenderAllRequests();
};

window.filterAllRequests = function(status, btnElement) {
    __requestsFilter = status;

    // Update chip styling
    const parent = btnElement.parentElement;
    if (parent) {
        parent.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        btnElement.classList.add('active');
    }
    renderAllRequestsTable();
};

window.fetchAndRenderAllRequests = async function() {
    const tbody = document.getElementById("allRequestsBody");
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading requests log...</td></tr>`;

    try {
        // Fetch from the root loanRequests node
        const snapshot = await firebase.database().ref('stallzShared_v1/loanRequests').once('value');
        const reqsObj = snapshot.val() || {};

        // Convert to array and sort newest first
        __allRequestsCache = Object.values(reqsObj).sort((a, b) => {
            const dateA = new Date(a.createdAt || 0);
            const dateB = new Date(b.createdAt || 0);
            return dateB - dateA;
        });

        renderAllRequestsTable();

    } catch (e) {
        console.error("Error fetching requests:", e);
        const isPerm = String(e).toLowerCase().includes("permission");
        if (isPerm) {
             tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:20px;">Permission Denied. Check Firebase rules.</td></tr>`;
        } else {
             tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:20px;">Failed to load requests log.</td></tr>`;
        }
    }
};

window.renderAllRequestsTable = function() {
    const tbody = document.getElementById("allRequestsBody");
    if (!tbody) return;

    // Apply Filters
    let filtered = __allRequestsCache;
    if (__requestsFilter !== 'ALL') {
        filtered = filtered.filter(r => {
            const status = String(r.status || "PENDING").toUpperCase();
            if (__requestsFilter === 'REJECTED' && (status === 'DECLINED' || status === 'REJECTED')) return true;
            return status === __requestsFilter;
        });
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted); font-style:italic;">No requests found in this category.</td></tr>`;
        return;
    }

    // Render Table
    tbody.innerHTML = filtered.map(req => {
        const dateStr = req.createdAt ? new Date(req.createdAt).toLocaleDateString("en-ZM", { day: 'numeric', month: 'short', year: '2-digit' }) : "-";

        let status = String(req.status || "PENDING").toUpperCase();
        if (status === "DECLINED") status = "REJECTED"; // Normalization

        let statusHtml = "";
        if (status === "PENDING") {
            statusHtml = `<span style="background:rgba(56, 189, 248, 0.1); color:#38bdf8; padding:4px 8px; border-radius:4px; font-size:0.65rem; font-weight:700;">PENDING</span>`;
        } else if (status === "APPROVED") {
            statusHtml = `<span style="background:rgba(52, 211, 153, 0.1); color:#34d399; padding:4px 8px; border-radius:4px; font-size:0.65rem; font-weight:700;">APPROVED</span>`;
        } else {
            statusHtml = `<span style="background:rgba(239, 68, 68, 0.1); color:#ef4444; padding:4px 8px; border-radius:4px; font-size:0.65rem; font-weight:700;">DECLINED</span>`;
        }

        // Show note/reason if rejected
        let reasonHtml = "";
        const rejectReason = req.declineReason || req.rejectionReason || req.reason;
        if ((status === "REJECTED" || status === "DECLINED") && rejectReason) {
             reasonHtml = `<div style="font-size:0.75rem; color:#ef4444; margin-top:4px; font-style:italic;"><strong>Reason:</strong> ${escapeHTML(rejectReason)}</div>`;
        } else if (status === "APPROVED") {
             reasonHtml = `<div style="font-size:0.75rem; color:#34d399; margin-top:4px;">Loan Created ✅</div>`;
        }

        return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;">
            <td style="font-size:0.8rem; color:var(--text-muted); vertical-align:top; padding-top:15px;">${dateStr}</td>
            <td style="vertical-align:top; padding-top:15px;">
                <div style="font-weight:700; color:var(--text-main); font-size: 0.95rem;">${escapeHTML(req.clientName || "Client")}</div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Item: ${escapeHTML(req.collateralItem || "-")}</div>
                ${reasonHtml}
            </td>
            <td style="font-weight:800; color:var(--primary); font-size:1.05rem; text-align:right; vertical-align:top; padding-top:15px;">
                ${formatMoney(req.amount)}
            </td>
            <td style="text-align:center; vertical-align:top; padding-top:15px;">
                ${statusHtml}
            </td>
            <td style="text-align:right; vertical-align:top; padding-top:15px;">
                <button class="btn-icon" style="color:#fff; background:rgba(255, 255, 255, 0.1); padding:6px 12px; border-radius:6px; font-size: 0.75rem; font-weight: 700; display:inline-block;" onclick="viewRequestLogDetails('${req.id}')">View Details</button>
            </td>
        </tr>
        `;
    }).join("");
};

window.viewRequestLogDetails = function(reqId) {
    // 1. Fetch the exact request from our cache (even if it's old and rejected)
    const req = __allRequestsCache.find(r => String(r.id) === String(reqId));
    if (!req) return;

    // 2. Safely inject it into the shared cache so the standard modal can read it
    if (!window.StallzShared) window.StallzShared = {};
    if (!window.StallzShared._cache) window.StallzShared._cache = {};
    if (!window.StallzShared._cache.loanRequests) window.StallzShared._cache.loanRequests = {};
    window.StallzShared._cache.loanRequests[reqId] = req;

    // 3. Close the Log table
    closePopup('allRequestsModal');

    // 4. Open the Request popup details
    setTimeout(() => {
        window.openLoanRequestModal(reqId);

        // Hide the "Approve/Reject" buttons if it's an old request that's already processed
        const status = String(req.status || "PENDING").toUpperCase();
        const footer = document.getElementById("loanRequestBody").nextElementSibling;
        if (footer) {
            footer.style.display = (status === "PENDING") ? "flex" : "none";
        }
    }, 350);
};

/* ============================================================================
 * LINK CODE SYSTEM (Manual Profile to App Profile Merging)
 * ============================================================================ */

window.generateLinkCode = async function(phone, name) {
    const cleanPhone = String(phone || "").replace(/\D/g, "");
    if (!cleanPhone) return showToast("This client needs a phone number first to generate a code.", "error");

    try {
        // 1. Check if a code ALREADY exists for this phone number
        const snap = await dataRef.child('activeLinkCodes').once('value');
        const allCodes = snap.val() || {};

        let existingCode = null;
        for (const [codeKey, data] of Object.entries(allCodes)) {
            if (data.targetPhone === cleanPhone) {
                existingCode = codeKey;
                break;
            }
        }

        if (existingCode) {
            // 2a. Reveal the existing persistent code
            showAdminDialog({
                title: 'Active Link Code Exists',
                message: `This client already has an active code waiting for them:\n\n👉  ${existingCode}  👈\n\nThis code will remain active until they use it to sync their account.`,
                btnText: 'Done',
                btnClass: 'btn-primary'
            });
            return;
        }

        // 2b. If no code exists, generate a new persistent one
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        await dataRef.child(`activeLinkCodes/${code}`).set({
            targetPhone: cleanPhone,
            clientName: name,
            createdAt: new Date().toISOString()
        });

        showAdminDialog({
            title: 'New Link Code Generated',
            message: `Give this 6-digit code to ${name}:\n\n👉  ${code}  👈\n\nThis code is permanently active until the client uses it to sync.`,
            btnText: 'Done',
            btnClass: 'btn-primary'
        });
    } catch (e) {
        showToast("Failed to generate code. Check database permissions.", "error");
    }
};

function startSyncCodeProcessor() {
    if (typeof firebase === 'undefined' || OFFLINE_TEST_MODE) return;

    // Listen for clients submitting codes from their app
    firebase.database().ref('stallzShared_v1/loanRequests').on('child_added', async (snap) => {
        const req = snap.val();
        if (req && req.type === "SYNC_CODE" && req.code && req.clientUid) {

            // 1. Verify the code exists in the Admin database
            const codeSnap = await dataRef.child(`activeLinkCodes/${req.code}`).once('value');
            if (codeSnap.exists()) {
                const targetPhone = codeSnap.val().targetPhone;
                const uid = req.clientUid;
                let updatedCount = 0;
                const updates = {};

                // 2. Find all manual loans matching that phone and bind them to the new UID
                (state.loans || []).forEach(loan => {
                    const lPhone = String(loan.clientPhone || "").replace(/\D/g, "");
                    if (lPhone === targetPhone && !loan.clientUid) {
                        loan.clientUid = uid; // Attach UID

                        // Update Master Database
                        const primaryPath = loan.__primaryLoanPath || `loans/${loan.id}`;
                        updates[`loanManagerData_v5/${primaryPath}/clientUid`] = uid;

                        // Push immediately to the Client's Portal
                        updates[`clients/${uid}/loans/${loan.id}`] = loan;
                        updatedCount++;
                    }
                });

                if (updatedCount > 0) {
                    await firebase.database().ref().update(updates);
                    showToast(`Code ${req.code} redeemed! Auto-linked ${updatedCount} loans to App user.`, "success");
                }

                // 3. Delete the used code so it can't be used again
                await dataRef.child(`activeLinkCodes/${req.code}`).remove();
            }

            // 4. Always delete the client's request payload to keep the queue clean
            await firebase.database().ref(`stallzShared_v1/loanRequests/${snap.key}`).remove();
        }
    });
}

// Start the processor 3 seconds after the Admin app loads
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(startSyncCodeProcessor, 3000);
});

/* ============================================================================
 * 🚀 STALLZ SMART ENGAGEMENT ENGINE (Automated Client Nudges)
 * ============================================================================ */
async function runSmartEngagementEngine() {
    if (!state.dataLoaded || OFFLINE_TEST_MODE) return;

    try {
        const now = Date.now();
        // Fetch the log to ensure we don't spam clients repeatedly
        const logSnap = await firebase.database().ref('engagementLog').once('value');
        const engagementLog = logSnap.val() || {};

        const updates = {};
        let messagesSent = 0;

        // Get all registered app users
        const users = window.StallzShared?.listUsers?.("client") || [];

        for (const user of users) {
            const uid = user.uid;
            if (!uid) continue;

            const userLog = engagementLog[uid] || {};
            const userLoans = (state.loans || []).filter(l => l.clientUid === uid);
            const activeLoans = userLoans.filter(l => l.status === "ACTIVE" || l.status === "OVERDUE");

            const firstName = (user.name || "Client").split(' ')[0];

            // ---------------------------------------------------------
            // CAMPAIGN 1: THE RETENTION OFFER (Inactive Users)
            // ---------------------------------------------------------
            // If they have NO active loans, and their last loan was paid over 7 days ago
            if (activeLoans.length === 0 && userLoans.length > 0) {
                // Find their most recent loan
                const lastLoan = userLoans.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
                const daysSincePaid = (now - new Date(lastLoan.updatedAt || lastLoan.createdAt).getTime()) / (1000 * 3600 * 24);

                // Send if it's been > 7 days, and we haven't sent this specific promo in 14 days
                if (daysSincePaid > 7 && (!userLog.retention || (now - userLog.retention > 14 * 24 * 3600 * 1000))) {
                    const notifId = "n_" + Date.now() + Math.floor(Math.random() * 1000);
                    updates[`clients/${uid}/notifications/${notifId}`] = {
                        id: notifId,
                        title: "👋 We miss you!",
                        body: `Hi ${firstName}, need a boost? Request a loan today and you can negotiate your interest rate directly with us!`,
                        read: false,
                        createdAt: new Date().toISOString(),
                        type: "PROMO"
                    };
                    updates[`engagementLog/${uid}/retention`] = now;
                    messagesSent++;
                }
            }

            // ---------------------------------------------------------
            // CAMPAIGN 2: THE BITE-SIZED PAYMENT HACK (Active Users)
            // ---------------------------------------------------------
            if (activeLoans.length > 0) {
                const loan = activeLoans[0];
                const dueDate = parseDateSmart(loan.dueDate);
                const daysLeft = dueDate ? Math.ceil((dueDate.getTime() - now) / (1000 * 3600 * 24)) : 0;

                // Send if they have more than 3 days left, and haven't gotten this tip in 7 days
                if (daysLeft > 3 && loan.balance > 0 && (!userLog.daily_hack || (now - userLog.daily_hack > 7 * 24 * 3600 * 1000))) {
                    const dailyAmount = Math.ceil(loan.balance / daysLeft);

                    const notifId = "n_" + Date.now() + Math.floor(Math.random() * 1000);
                    updates[`clients/${uid}/notifications/${notifId}`] = {
                        id: notifId,
                        title: "💡 Stallz Repayment Hack",
                        body: `Did you know? If you pay just K${dailyAmount} every day, your loan will be completely cleared by your due date!`,
                        read: false,
                        createdAt: new Date().toISOString(),
                        type: "TIP"
                    };
                    updates[`engagementLog/${uid}/daily_hack`] = now;
                    messagesSent++;
                }

                // ---------------------------------------------------------
                // CAMPAIGN 3: THE 3-DAY WARNING (Active Users)
                // ---------------------------------------------------------
                // Send ONLY ONCE for this specific loan when it hits 3 days left
                if (daysLeft === 3 && loan.balance > 0 && userLog.warning_3day !== loan.id) {
                    const notifId = "n_" + Date.now() + Math.floor(Math.random() * 1000);
                    updates[`clients/${uid}/notifications/${notifId}`] = {
                        id: notifId,
                        title: "⏳ Due Date Approaching",
                        body: `Hi ${firstName}, you have exactly 3 days left until your loan is due. Tap here to view payment options.`,
                        read: false,
                        createdAt: new Date().toISOString(),
                        type: "ALERT"
                    };
                    updates[`engagementLog/${uid}/warning_3day`] = loan.id; // Log the specific loan ID so it doesn't fire twice
                    messagesSent++;
                }
            }
        }

       // If we generated any messages, execute the silent database update
        if (messagesSent > 0) {
            await firebase.database().ref().update(updates);
            console.log(`🚀 Smart Engine fired ${messagesSent} automated nudges.`);
        }

    } catch (error) {
        console.warn("Engagement Engine error:", error);
    }
}

