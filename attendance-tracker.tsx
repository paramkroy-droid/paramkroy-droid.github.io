import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Plus, Minus, Pencil, Trash2, X, Settings, Send, Sparkles,
  Loader2, Calendar, BookOpen, Clock,
  AlertTriangle, GraduationCap, KeyRound, Info,
} from 'lucide-react';

/* =======================================================================
   CONSTANTS & HELPERS
======================================================================= */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getPct = (attended, total) => (total > 0 ? (attended / total) * 100 : 0);

function getStatus(attended, total, min, target) {
  if (total === 0) return 'neutral';
  const pct = getPct(attended, total);
  if (pct >= target) return 'green';
  if (pct >= min) return 'yellow';
  return 'red';
}

const STATUS_STYLES = {
  green: { hex: '#059669', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', ring: 'ring-emerald-100', label: 'On Track' },
  yellow: { hex: '#D97706', chip: 'bg-amber-50 text-amber-700 border-amber-200', ring: 'ring-amber-100', label: 'Needs Attention' },
  red: { hex: '#DC2626', chip: 'bg-rose-50 text-rose-700 border-rose-200', ring: 'ring-rose-100', label: 'At Risk' },
  neutral: { hex: '#94A3B8', chip: 'bg-slate-100 text-slate-500 border-slate-200', ring: 'ring-slate-100', label: 'No Classes Yet' },
};

// Max additional classes that could be HELD (and missed — attended count fixed)
// before the percentage would fall below thresholdPct.
function classesCanMiss(attended, total, thresholdPct) {
  if (thresholdPct <= 0) return Infinity;
  if (total === 0 && attended === 0) return 0;
  return Math.floor((attended * 100) / thresholdPct - total);
}

// Classes needed, attended consecutively (attended & total both +1 each time),
// to reach thresholdPct from the current standing.
function classesNeededToReach(attended, total, thresholdPct) {
  if (thresholdPct >= 100) return attended === total ? 0 : null; // null = impossible
  const raw = (thresholdPct * total - 100 * attended) / (100 - thresholdPct);
  return Math.max(0, Math.ceil(raw - 1e-9));
}

function formatTime12(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${period}`;
}

function durationLabel(start, end) {
  if (!start || !end) return '';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function todayName() {
  try {
    const n = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    return DAYS.includes(n) ? n : 'Monday';
  } catch (e) {
    return 'Monday';
  }
}

/* =======================================================================
   PERSISTENCE (window.storage)
======================================================================= */

async function loadKey(key, fallback) {
  try {
    const res = await window.storage.get(key, false);
    if (res && typeof res.value === 'string') return JSON.parse(res.value);
    return fallback;
  } catch (e) {
    return fallback;
  }
}

async function saveKey(key, value) {
  try {
    const res = await window.storage.set(key, JSON.stringify(value), false);
    return !!res;
  } catch (e) {
    return false;
  }
}

/* =======================================================================
   AI ASSISTANT — context builder + provider callers
======================================================================= */

function buildLiveContext(subjects, timetable) {
  const subjectsData = subjects.map((s) => {
    const pct = getPct(s.attended, s.total);
    return {
      name: s.name,
      classesAttended: s.attended,
      classesHeld: s.total,
      currentAttendancePercent: Math.round(pct * 10) / 10,
      minRequiredPercent: s.min,
      targetPercent: s.target,
      maxClassesCanMissBeforeBelowTarget: Math.max(0, classesCanMiss(s.attended, s.total, s.target)),
      maxClassesCanMissBeforeBelowMinimum: Math.max(0, classesCanMiss(s.attended, s.total, s.min)),
      classesNeededConsecutivelyToReachTarget: classesNeededToReach(s.attended, s.total, s.target),
      classesNeededConsecutivelyToReachMinimum: pct < s.min ? classesNeededToReach(s.attended, s.total, s.min) : 0,
    };
  });
  const timetableData = timetable
    .slice()
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start))
    .map((t) => {
      const subj = subjects.find((s) => s.id === t.subjectId);
      return { day: t.day, subject: subj ? subj.name : '(deleted subject)', type: t.type, start: t.start, end: t.end };
    });
  return { subjects: subjectsData, timetable: timetableData };
}

function buildSystemPrompt(liveContext) {
  return [
    "You are the built-in AI study assistant inside a student's Attendance Tracker web app.",
    'You can see the live attendance data and weekly timetable below. It is accurate as of right now — trust it completely, never claim you lack access to it.',
    '',
    'LIVE DATA (JSON):',
    JSON.stringify(liveContext, null, 2),
    '',
    'Field notes:',
    '- maxClassesCanMissBeforeBelowTarget / Minimum: precomputed. How many additional classes could be HELD (and missed — attended count unchanged) before the percentage would drop below that threshold. 0 means already at or below it.',
    '- classesNeededConsecutivelyToReachTarget / Minimum: precomputed. How many classes the student needs to attend in a row (each adds 1 to both attended and held) to reach that threshold. null means it is mathematically impossible to reach exactly (only happens for a 100% goal once at least one class has already been missed).',
    '',
    'For those two scenarios, use the precomputed fields directly — do not redo that arithmetic yourself.',
    "If asked about a custom percentage that isn't min or target, compute it carefully with these formulas and show your work briefly:",
    '  classes that can still be missed = floor(attended*100/X - held), minimum 0',
    '  classes needed in a row to reach X% = ceil((X*held - 100*attended)/(100-X)), minimum 0 (if X=100: 0 if attended=held, else impossible)',
    'Keep answers short, specific, and encouraging. Refer to subjects by name. Use the timetable data for schedule questions. If something truly is not in the data, say so plainly instead of guessing.',
  ].join('\n');
}

async function callClaude(liveContext, history) {
  const system = buildSystemPrompt(liveContext);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Assistant request failed (${res.status})`);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : "I couldn't put together a response there — try rephrasing?";
}

async function callGemini(apiKey, liveContext, history) {
  const system = buildSystemPrompt(liveContext);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: 1000 },
    }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 403) throw new Error('Gemini rejected the request — double check your API key.');
    throw new Error(`Gemini request failed (${res.status})`);
  }
  const data = await res.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return text || "I couldn't put together a response there — try rephrasing?";
}

/* =======================================================================
   SMALL SHARED UI PIECES
======================================================================= */

const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;0,700;1,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
    .font-display { font-family: 'Fraunces', Georgia, serif; }
    .font-data { font-family: 'IBM Plex Mono', 'Courier New', monospace; }
    .app-root { font-family: 'Inter', system-ui, sans-serif; }
    @media (prefers-reduced-motion: reduce) {
      .app-root * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
    }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    @media (min-width: 640px) { .ai-drawer { width: 420px; } }
  `}</style>
);

function StatusChip({ status }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${s.chip}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.hex }} />
      {s.label}
    </span>
  );
}

function ProgressLedgerBar({ pct, min, target, status }) {
  const s = STATUS_STYLES[status];
  const fillWidth = clamp(pct, 0, 100);
  return (
    <div className="relative pt-2 pb-1">
      <div className="relative h-2.5 w-full rounded-full bg-slate-100">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${fillWidth}%`, backgroundColor: s.hex }}
        />
        <div
          className="absolute rounded bg-rose-400"
          style={{ left: `calc(${clamp(min, 0, 100)}% - 1px)`, top: '-4px', height: '18px', width: '2px' }}
          title={`Minimum ${min}%`}
        />
        <div
          className="absolute rounded bg-emerald-500"
          style={{ left: `calc(${clamp(target, 0, 100)}% - 1px)`, top: '-4px', height: '18px', width: '2px' }}
          title={`Target ${target}%`}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs font-medium text-slate-400">
        <span>Min {min}%</span>
        <span>Target {target}%</span>
      </div>
    </div>
  );
}

function CounterRow({ label, value, onInc, onDec, disabledDec }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDec}
          disabled={disabledDec}
          aria-label={`Decrease ${label}`}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:bg-slate-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Minus size={14} />
        </button>
        <span className="font-data w-7 text-center text-sm font-semibold tabular-nums text-slate-800">{value}</span>
        <button
          type="button"
          onClick={onInc}
          aria-label={`Increase ${label}`}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition hover:bg-slate-50 active:scale-95"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, message, actionLabel, onAction }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
        <Icon size={22} />
      </div>
      <h3 className="font-display text-lg font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 active:scale-95"
        >
          <Plus size={16} /> {actionLabel}
        </button>
      )}
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertTriangle size={18} />
        </div>
        <h3 className="font-display text-base font-semibold text-slate-800">{title}</h3>
        <p className="mt-1.5 text-sm text-slate-500">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-rose-700"
          >
            {confirmLabel || 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =======================================================================
   SUBJECT CARD + MODAL
======================================================================= */

function SubjectCard({ subject, onEdit, onDelete, onAdjust }) {
  const pct = getPct(subject.attended, subject.total);
  const status = getStatus(subject.attended, subject.total, subject.min, subject.target);
  const s = STATUS_STYLES[status];

  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ${s.ring} transition hover:shadow-md`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-semibold text-slate-800">{subject.name}</h3>
          <div className="mt-1"><StatusChip status={status} /></div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(subject)}
            aria-label={`Edit ${subject.name}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-50 hover:text-slate-700"
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(subject)}
            aria-label={`Delete ${subject.name}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="font-data text-3xl font-semibold tabular-nums" style={{ color: s.hex }}>
          {subject.total > 0 ? pct.toFixed(1) : '—'}
        </span>
        {subject.total > 0 && <span className="font-data text-sm font-medium text-slate-400">%</span>}
      </div>

      <ProgressLedgerBar pct={pct} min={subject.min} target={subject.target} status={status} />

      <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3">
        <CounterRow
          label="Attended"
          value={subject.attended}
          onDec={() => onAdjust(subject.id, 'attended', -1)}
          onInc={() => onAdjust(subject.id, 'attended', 1)}
          disabledDec={subject.attended <= 0}
        />
        <CounterRow
          label="Held"
          value={subject.total}
          onDec={() => onAdjust(subject.id, 'total', -1)}
          onInc={() => onAdjust(subject.id, 'total', 1)}
          disabledDec={subject.total <= 0}
        />
      </div>
    </div>
  );
}

function SubjectModal({ initial, onSave, onClose }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial ? initial.name : '');
  const [min, setMin] = useState(initial ? String(initial.min) : '75');
  const [target, setTarget] = useState(initial ? String(initial.target) : '85');
  const [attended, setAttended] = useState(initial ? String(initial.attended) : '0');
  const [total, setTotal] = useState(initial ? String(initial.total) : '0');
  const [error, setError] = useState('');
  const nameRef = useRef(null);

  useEffect(() => { if (nameRef.current) nameRef.current.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    const minN = Number(min), targetN = Number(target), attN = Number(attended), totN = Number(total);
    if (!trimmed) return setError('Give the subject a name.');
    if (!Number.isFinite(minN) || minN < 0 || minN > 100) return setError('Minimum attendance must be between 0 and 100.');
    if (!Number.isFinite(targetN) || targetN < 0 || targetN > 100) return setError('Target attendance must be between 0 and 100.');
    if (targetN < minN) return setError('Target attendance should be at or above the minimum.');
    if (!Number.isInteger(attN) || attN < 0) return setError('Classes attended must be a whole number, 0 or more.');
    if (!Number.isInteger(totN) || totN < 0) return setError('Classes held must be a whole number, 0 or more.');
    if (attN > totN) return setError('Classes attended cannot exceed classes held.');
    setError('');
    onSave({ name: trimmed, min: minN, target: targetN, attended: attN, total: totN });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        style={{ maxHeight: '90vh' }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-slate-800">{isEdit ? 'Edit Subject' : 'Add Subject'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Subject Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Organic Chemistry"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Minimum %</label>
              <input
                type="number" min="0" max="100" value={min}
                onChange={(e) => setMin(e.target.value)}
                className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Target %</label>
              <input
                type="number" min="0" max="100" value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Classes Attended</label>
              <input
                type="number" min="0" step="1" value={attended}
                onChange={(e) => setAttended(e.target.value)}
                className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Classes Held</label>
              <input
                type="number" min="0" step="1" value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50">
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">
            {isEdit ? 'Save Changes' : 'Add Subject'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* =======================================================================
   TIMETABLE VIEW + MODAL
======================================================================= */

function SessionModal({ initial, subjects, defaultDay, onSave, onClose }) {
  const isEdit = !!initial;
  const [day, setDay] = useState(initial ? initial.day : defaultDay);
  const [subjectId, setSubjectId] = useState(initial ? initial.subjectId : (subjects[0] ? subjects[0].id : ''));
  const [type, setType] = useState(initial ? initial.type : 'Lecture');
  const [start, setStart] = useState(initial ? initial.start : '09:00');
  const [end, setEnd] = useState(initial ? initial.end : '10:00');
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleSubmit(e) {
    e.preventDefault();
    if (!subjectId) return setError('Add a subject first, then schedule a session for it.');
    if (!start || !end) return setError('Set both a start and an end time.');
    if (end <= start) return setError('End time must be after the start time.');
    setError('');
    onSave({ day, subjectId, type, start, end });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        style={{ maxHeight: '90vh' }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-slate-800">{isEdit ? 'Edit Session' : 'Add Session'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>

        {subjects.length === 0 ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-700">
            <Info size={16} className="mt-0.5 shrink-0" /> You need at least one subject before you can schedule a session.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Day</label>
              <select value={day} onChange={(e) => setDay(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Subject</label>
              <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100">
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Session Type</label>
              <div className="flex gap-2">
                {['Lecture', 'Practical'].map((t) => (
                  <button
                    key={t} type="button" onClick={() => setType(t)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition ${type === t ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Start Time</label>
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">End Time</label>
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="font-data w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
              </div>
            </div>
            {error && (
              <p className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
              </p>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50">
            Cancel
          </button>
          {subjects.length > 0 && (
            <button type="submit" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">
              {isEdit ? 'Save Changes' : 'Add Session'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function TimetableView({ subjects, timetable, onAdd, onEdit, onDelete }) {
  const [selectedDay, setSelectedDay] = useState(todayName());

  const sessions = useMemo(() => (
    timetable
      .filter((t) => t.day === selectedDay)
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
  ), [timetable, selectedDay]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setSelectedDay(d)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                selectedDay === d ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className="sm:hidden">{DAY_SHORT[d]}</span>
              <span className="hidden sm:inline">{d}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onAdd(selectedDay)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
        >
          <Plus size={16} /> <span className="hidden sm:inline">Add Session</span>
        </button>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title={`Nothing scheduled for ${selectedDay}`}
          message="Add a lecture or practical session to build out your weekly timetable."
          actionLabel="Add Session"
          onAction={() => onAdd(selectedDay)}
        />
      ) : (
        <div className="space-y-2.5">
          {sessions.map((t) => {
            const subj = subjects.find((s) => s.id === t.subjectId);
            const isLecture = t.type === 'Lecture';
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex w-20 shrink-0 flex-col items-start font-data text-xs font-semibold text-slate-500">
                  <span>{formatTime12(t.start)}</span>
                  <span className="text-slate-300">to</span>
                  <span>{formatTime12(t.end)}</span>
                </div>
                <div className="h-10 w-px shrink-0 bg-slate-100" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{subj ? subj.name : 'Deleted subject'}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${isLecture ? 'bg-indigo-50 text-indigo-600' : 'bg-purple-50 text-purple-600'}`}>
                      {t.type}
                    </span>
                    <span className="flex items-center gap-1 text-xs font-medium text-slate-400">
                      <Clock size={11} /> {durationLabel(t.start, t.end)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => onEdit(t)} aria-label="Edit session" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-50 hover:text-slate-700">
                    <Pencil size={15} />
                  </button>
                  <button type="button" onClick={() => onDelete(t)} aria-label="Delete session" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =======================================================================
   AI ASSISTANT DRAWER
======================================================================= */

function AIDrawer({ open, onClose, subjects, timetable, aiSettings, onSaveSettings }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState(aiSettings.geminiKey || '');
  const scrollRef = useRef(null);

  useEffect(() => { setKeyDraft(aiSettings.geminiKey || ''); }, [aiSettings.geminiKey]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, open]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && open) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const suggestions = subjects.length
    ? [
        `How many classes can I miss in ${subjects[0].name} before I drop below my target?`,
        `How many ${subjects[0].name} classes do I need to attend in a row to hit my target?`,
        'Which subjects are at risk right now?',
      ]
    : [];

  async function send(text) {
    const trimmed = (text !== undefined ? text : input).trim();
    if (!trimmed || loading) return;
    if (aiSettings.provider === 'gemini' && !aiSettings.geminiKey.trim()) {
      setError('Add your Gemini API key in settings, or switch to the built-in assistant.');
      setSettingsOpen(true);
      return;
    }
    const nextHistory = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);
    setError('');
    try {
      const ctx = buildLiveContext(subjects, timetable);
      const reply = aiSettings.provider === 'gemini'
        ? await callGemini(aiSettings.geminiKey, ctx, nextHistory)
        : await callClaude(ctx, nextHistory);
      setMessages((h) => [...h, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError((err && err.message) || 'Something went wrong reaching the assistant.');
    } finally {
      setLoading(false);
    }
  }

  function saveGeminiKey() {
    onSaveSettings({ ...aiSettings, geminiKey: keyDraft.trim() });
  }

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-slate-900/30" onClick={onClose} />}
      <div
        className={`ai-drawer fixed right-0 top-0 z-50 flex h-full w-full flex-col bg-white shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white">
              <Sparkles size={16} />
            </div>
            <div>
              <h3 className="font-display text-sm font-semibold leading-tight text-slate-800">Study Assistant</h3>
              <p className="text-xs leading-tight text-slate-400">
                {aiSettings.provider === 'gemini' ? 'Using your Gemini key' : 'Built-in — no setup needed'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-label="Assistant settings" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-50 hover:text-slate-700">
              <Settings size={17} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close assistant" className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-50 hover:text-slate-700">
              <X size={19} />
            </button>
          </div>
        </div>

        {settingsOpen && (
          <div className="space-y-3 border-b border-slate-100 bg-slate-50 px-4 py-3.5">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">AI Provider</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onSaveSettings({ ...aiSettings, provider: 'claude' })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition ${aiSettings.provider === 'claude' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                >
                  Built-in
                </button>
                <button
                  type="button"
                  onClick={() => onSaveSettings({ ...aiSettings, provider: 'gemini' })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition ${aiSettings.provider === 'gemini' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                >
                  Gemini
                </button>
              </div>
            </div>
            {aiSettings.provider === 'gemini' && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <KeyRound size={12} /> Gemini API Key
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="Paste your key"
                    className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                  <button type="button" onClick={saveGeminiKey} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700">
                    Save
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-snug text-slate-400">
                  Saved privately to your account for this app — get a free key from Google AI Studio. The built-in assistant needs no key at all.
                </p>
              </div>
            )}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Ask me about your attendance — I can see your live subjects, counts, and timetable.
              </p>
              {suggestions.map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => send(sug)}
                  className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left text-sm text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  {sug}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                style={{ maxWidth: '85%' }}
                className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-700'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-400">
                <Loader2 size={14} className="animate-spin" /> Thinking…
              </div>
            </div>
          )}
          {error && (
            <p className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="flex items-center gap-2 border-t border-slate-100 px-3 py-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your attendance…"
            className="flex-1 rounded-full border border-slate-200 px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </>
  );
}

/* =======================================================================
   APP
======================================================================= */

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [subjects, setSubjects] = useState([]);
  const [timetable, setTimetable] = useState([]);
  const [aiSettings, setAiSettings] = useState({ provider: 'claude', geminiKey: '' });
  const [storageWarning, setStorageWarning] = useState(false);

  const [tab, setTab] = useState('dashboard');
  const [aiOpen, setAiOpen] = useState(false);

  const [subjectModal, setSubjectModal] = useState(null); // null | 'new' | subject object
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState(null);

  const [sessionModal, setSessionModal] = useState(null); // null | {day} | session object
  const [deleteSessionTarget, setDeleteSessionTarget] = useState(null);

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  /* ---- load once ---- */
  useEffect(() => {
    (async () => {
      const [s, t, a] = await Promise.all([
        loadKey('subjects', []),
        loadKey('timetable', []),
        loadKey('ai-settings', { provider: 'claude', geminiKey: '' }),
      ]);
      setSubjects(Array.isArray(s) ? s : []);
      setTimetable(Array.isArray(t) ? t : []);
      setAiSettings(a && typeof a === 'object' ? { provider: a.provider || 'claude', geminiKey: a.geminiKey || '' } : { provider: 'claude', geminiKey: '' });
      setLoaded(true);
    })();
  }, []);

  /* ---- persist on change ---- */
  useEffect(() => {
    if (!loaded) return;
    saveKey('subjects', subjects).then((ok) => setStorageWarning(!ok));
  }, [subjects, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveKey('timetable', timetable).then((ok) => setStorageWarning(!ok));
  }, [timetable, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveKey('ai-settings', aiSettings);
  }, [aiSettings, loaded]);

  /* ---- subject actions ---- */
  const addSubject = useCallback((data) => {
    setSubjects((prev) => [...prev, { id: uid(), ...data }]);
  }, []);
  const updateSubject = useCallback((id, data) => {
    setSubjects((prev) => prev.map((s) => (s.id === id ? { ...s, ...data } : s)));
  }, []);
  const deleteSubject = useCallback((id) => {
    setSubjects((prev) => prev.filter((s) => s.id !== id));
    setTimetable((prev) => prev.filter((t) => t.subjectId !== id));
  }, []);
  const adjustSubject = useCallback((id, field, delta) => {
    setSubjects((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      let { attended, total } = s;
      if (field === 'attended') {
        if (delta > 0) {
          attended += 1;
          if (attended > total) total = attended;
        } else {
          attended = Math.max(0, attended - 1);
        }
      } else {
        if (delta > 0) {
          total += 1;
        } else {
          total = Math.max(0, total - 1);
          if (attended > total) attended = total;
        }
      }
      return { ...s, attended, total };
    }));
  }, []);

  /* ---- timetable actions ---- */
  const addSession = useCallback((data) => setTimetable((prev) => [...prev, { id: uid(), ...data }]), []);
  const updateSession = useCallback((id, data) => setTimetable((prev) => prev.map((t) => (t.id === id ? { ...t, ...data } : t))), []);
  const deleteSession = useCallback((id) => setTimetable((prev) => prev.filter((t) => t.id !== id)), []);

  /* ---- reset ---- */
  function resetAll() {
    setSubjects([]);
    setTimetable([]);
    setResetConfirmOpen(false);
  }

  const stats = useMemo(() => {
    let atRisk = 0, attention = 0;
    subjects.forEach((s) => {
      const st = getStatus(s.attended, s.total, s.min, s.target);
      if (st === 'red') atRisk += 1;
      if (st === 'yellow') attention += 1;
    });
    return { total: subjects.length, atRisk, attention };
  }, [subjects]);

  const relatedSessionCount = deleteSubjectTarget
    ? timetable.filter((t) => t.subjectId === deleteSubjectTarget.id).length
    : 0;

  if (!loaded) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm font-medium">Loading your data…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root min-h-screen w-full bg-slate-50 pb-16">
      <GlobalStyles />

      {storageWarning && (
        <div className="flex items-center justify-center gap-2 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-700">
          <AlertTriangle size={13} /> Changes may not be saving right now — your data stays on screen but might not persist.
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <GraduationCap size={19} />
            </div>
            <span className="font-display text-lg font-semibold text-slate-800">Attendance Ledger</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">
              <button
                type="button"
                onClick={() => setTab('dashboard')}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${tab === 'dashboard' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => setTab('timetable')}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${tab === 'timetable' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
              >
                Timetable
              </button>
            </div>
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-900"
            >
              <Sparkles size={15} /> <span className="hidden sm:inline">Assistant</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === 'dashboard' && (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-4 text-sm">
                <div>
                  <span className="font-data text-xl font-semibold text-slate-800">{stats.total}</span>
                  <span className="ml-1.5 text-slate-400">subjects</span>
                </div>
                {stats.attention > 0 && (
                  <div>
                    <span className="font-data text-xl font-semibold text-amber-600">{stats.attention}</span>
                    <span className="ml-1.5 text-slate-400">need attention</span>
                  </div>
                )}
                {stats.atRisk > 0 && (
                  <div>
                    <span className="font-data text-xl font-semibold text-rose-600">{stats.atRisk}</span>
                    <span className="ml-1.5 text-slate-400">at risk</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSubjectModal('new')}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
              >
                <Plus size={16} /> Add Subject
              </button>
            </div>

            {subjects.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No subjects yet"
                message="Add your first subject to start tracking attendance, set your minimum and target percentages, and watch the numbers update as you go."
                actionLabel="Add Subject"
                onAction={() => setSubjectModal('new')}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {subjects.map((s) => (
                  <SubjectCard
                    key={s.id}
                    subject={s}
                    onEdit={(subj) => setSubjectModal(subj)}
                    onDelete={(subj) => setDeleteSubjectTarget(subj)}
                    onAdjust={adjustSubject}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'timetable' && (
          <TimetableView
            subjects={subjects}
            timetable={timetable}
            onAdd={(day) => setSessionModal({ day })}
            onEdit={(session) => setSessionModal(session)}
            onDelete={(session) => setDeleteSessionTarget(session)}
          />
        )}
      </main>

      <footer className="mx-auto max-w-5xl px-4 py-6 text-center text-xs text-slate-400">
        Your data is saved privately to your account.{' '}
        <button type="button" onClick={() => setResetConfirmOpen(true)} className="font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-rose-600">
          Reset all data
        </button>
      </footer>

      <AIDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        subjects={subjects}
        timetable={timetable}
        aiSettings={aiSettings}
        onSaveSettings={setAiSettings}
      />

      {subjectModal && (
        <SubjectModal
          initial={subjectModal === 'new' ? null : subjectModal}
          onClose={() => setSubjectModal(null)}
          onSave={(data) => {
            if (subjectModal === 'new') addSubject(data);
            else updateSubject(subjectModal.id, data);
            setSubjectModal(null);
          }}
        />
      )}

      {deleteSubjectTarget && (
        <ConfirmDialog
          title={`Delete ${deleteSubjectTarget.name}?`}
          message={
            relatedSessionCount > 0
              ? `This also removes ${relatedSessionCount} scheduled session${relatedSessionCount === 1 ? '' : 's'} for this subject. This can't be undone.`
              : "This can't be undone."
          }
          confirmLabel="Delete Subject"
          onCancel={() => setDeleteSubjectTarget(null)}
          onConfirm={() => {
            deleteSubject(deleteSubjectTarget.id);
            setDeleteSubjectTarget(null);
          }}
        />
      )}

      {sessionModal && (
        <SessionModal
          initial={sessionModal.day && !sessionModal.id ? null : sessionModal}
          subjects={subjects}
          defaultDay={sessionModal.day || todayName()}
          onClose={() => setSessionModal(null)}
          onSave={(data) => {
            if (sessionModal.id) updateSession(sessionModal.id, data);
            else addSession(data);
            setSessionModal(null);
          }}
        />
      )}

      {deleteSessionTarget && (
        <ConfirmDialog
          title="Delete this session?"
          message="This can't be undone."
          confirmLabel="Delete Session"
          onCancel={() => setDeleteSessionTarget(null)}
          onConfirm={() => {
            deleteSession(deleteSessionTarget.id);
            setDeleteSessionTarget(null);
          }}
        />
      )}

      {resetConfirmOpen && (
        <ConfirmDialog
          title="Reset all data?"
          message="This permanently clears every subject and timetable entry. This can't be undone."
          confirmLabel="Reset Everything"
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={resetAll}
        />
      )}
    </div>
  );
}
