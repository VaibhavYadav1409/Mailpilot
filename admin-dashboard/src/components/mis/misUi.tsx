'use client';

/**
 * Shared look + wording for the MIS auto-check: one place decides what each
 * colour means and how the reason is explained, so MIS Reports and the
 * Employees → MIS staff screen always say the same thing.
 */
import { useState } from 'react';
import { CheckCircle2, ChevronDown, CircleSlash, ExternalLink, HelpCircle, TriangleAlert, XCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

export type MisStatus = 'COMPLETE' | 'INCOMPLETE' | 'MISSING' | 'ERROR' | 'NOT_CHECKED' | 'OFF';

export interface MisBlank {
  sheet: string;
  cell: string;
  field: string;
}

/** One MIS file's result for one day (backend misService.getMisStatusForDate → sources[]). */
export interface MisSourceDay {
  id: string;
  label: string;
  fileName: string | null;
  webUrl: string;
  checkedBy: string | null;
  approvedBy: string | null;
  status: MisStatus;
  rowCount: number;
  missingColumns: string[];
  blanks: MisBlank[];
  note: string | null;
  checkedAt: string | null;
  /** When the day became fully filled. */
  completedAt?: string | null;
  /** When the Excel file was last saved, and by whom (OneDrive / SharePoint). */
  fileSavedAt?: string | null;
  fileSavedBy?: string | null;
}

/** "05 Oct, 6:02 pm" in India time. */
export function whenIst(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

/** "Excel last saved 05 Oct, 6:02 pm by Mamta · filled completely 05 Oct, 5:40 pm" — when the employee actually worked on it. */
export function FileSaved({ sources, className }: { sources: Pick<MisSourceDay, 'id' | 'label' | 'fileSavedAt' | 'fileSavedBy' | 'completedAt'>[]; className?: string }) {
  const shown = sources.filter((s) => s.fileSavedAt || s.completedAt);
  if (!shown.length) return null;
  return (
    <span className={cn('inline-flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500', className)}>
      {shown.map((s) => (
        <span key={s.id} title="From OneDrive / SharePoint: when the Excel file was last saved, and by whom">
          {sources.length > 1 && <b className="font-medium">{s.label}: </b>}
          {s.fileSavedAt && (
            <>
              Excel last saved {whenIst(s.fileSavedAt)}
              {s.fileSavedBy ? ` by ${s.fileSavedBy}` : ''}
            </>
          )}
          {s.completedAt && <>{s.fileSavedAt ? ' · ' : ''}fully filled {whenIst(s.completedAt)}</>}
        </span>
      ))}
    </span>
  );
}

/** A person's MIS for one day, across all their files. */
export interface MisDay {
  status: MisStatus;
  submitted: boolean;
  completedAt: string | null;
  missingColumns: string[];
  sources: MisSourceDay[];
}

/** Blanks at or above this mean "not filled" rather than "incomplete" (backend misSheet.NOT_FILLED_BLANKS). */
export const NOT_FILLED_BLANKS = 20;

type Tone = 'green' | 'amber' | 'red' | 'gray';

export const TONE: Record<Tone, { badge: string; text: string; border: string; dot: string }> = {
  green: {
    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    border: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
  },
  amber: {
    badge: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/25',
    text: 'text-amber-700 dark:text-amber-400',
    border: 'border-l-amber-500',
    dot: 'bg-amber-500',
  },
  red: {
    badge: 'bg-red-500/10 text-red-700 dark:text-red-400 ring-1 ring-red-500/20',
    text: 'text-red-600 dark:text-red-400',
    border: 'border-l-red-500',
    dot: 'bg-red-500',
  },
  gray: {
    badge: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 ring-1 ring-gray-200 dark:ring-gray-700',
    text: 'text-gray-500',
    border: 'border-l-gray-300 dark:border-l-gray-700',
    dot: 'bg-gray-400',
  },
};

export function toneOf(status: MisStatus | undefined | null): Tone {
  switch (status) {
    case 'COMPLETE':
      return 'green';
    case 'INCOMPLETE':
      return 'amber';
    case 'MISSING':
      return 'red';
    default:
      return 'gray';
  }
}

/** Short label for a badge. */
export function statusLabel(status: MisStatus | undefined | null, blanks = 0): string {
  switch (status) {
    case 'COMPLETE':
      return 'Submitted';
    case 'INCOMPLETE':
      return `Incomplete · ${blanks} blank`;
    case 'MISSING':
      return 'Not submitted';
    case 'ERROR':
      return "Can't read file";
    case 'OFF':
      return 'Day off';
    default:
      return 'Not checked yet';
  }
}

const ICON: Record<Tone, typeof CheckCircle2> = {
  green: CheckCircle2,
  amber: TriangleAlert,
  red: XCircle,
  gray: CircleSlash,
};

export function StatusBadge({
  status,
  blanks = 0,
  title,
  size = 'md',
}: {
  status: MisStatus | undefined | null;
  blanks?: number;
  title?: string;
  size?: 'sm' | 'md';
}) {
  const tone = toneOf(status);
  const Icon = ICON[tone];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        TONE[tone].badge,
      )}
    >
      <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
      {statusLabel(status, blanks)}
    </span>
  );
}

/** "30-09-2026" */
export function dmy(date: string) {
  return date.split('-').reverse().join('-');
}

/** "Wed, 30 Sep" */
export function shortDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Plain-English reason for one file's result — what the CEO reads to know why
 * someone is red, amber or green.
 */
export function explainSource(s: MisSourceDay, date: string): string {
  switch (s.status) {
    case 'COMPLETE':
      return `Every entry they usually fill has something for ${dmy(date)}.`;
    case 'INCOMPLETE':
      return `Filled, but ${s.missingColumns.length} of their usual ${s.missingColumns.length === 1 ? 'entry is' : 'entries are'} blank for ${dmy(date)}.`;
    case 'MISSING':
      if (s.note?.startsWith('Not filled')) return `${s.note} (${NOT_FILLED_BLANKS}+ blanks counts as not filled.)`;
      if (s.note?.startsWith('No entry dated')) return `There is no ${dmy(date)} column in the sheet — the day was never started.`;
      return s.note ?? `Nothing was filled for ${dmy(date)}.`;
    case 'ERROR':
      return `MailPilot couldn't open this file: ${s.note ?? 'unknown error'}`;
    case 'OFF':
      return `Day off (Sunday, weekly-off Saturday or holiday) — no MIS needed, not counted.`;
    default:
      return 'Not read yet — the first check runs within 10 minutes of linking.';
  }
}

/** Reason for a person's whole day (all their files). */
export function explainDay(mis: MisDay | null, date: string, hasUpload = false): string {
  if (!mis) return hasUpload ? 'Uploaded a daily report.' : 'No MIS file linked and no report uploaded.';
  if (mis.sources.length === 1) return explainSource(mis.sources[0], date);
  const bad = mis.sources.filter((s) => s.status !== 'COMPLETE' && s.status !== 'OFF');
  if (bad.length === 0) return `All ${mis.sources.length} MIS files are fully filled for ${dmy(date)}.`;
  return bad.map((s) => `${s.label}: ${explainSource(s, date)}`).join(' ');
}

/** Links to every file of a person. */
export function OpenLinks({ sources, className }: { sources: Pick<MisSourceDay, 'id' | 'label' | 'webUrl' | 'fileName'>[]; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap gap-x-3 gap-y-1', className)}>
      {sources.map((s) => (
        <a
          key={s.id}
          href={s.webUrl}
          target="_blank"
          rel="noreferrer"
          title={s.fileName ?? undefined}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline whitespace-nowrap"
        >
          <ExternalLink className="w-3.5 h-3.5" /> {sources.length > 1 ? s.label : 'Open MIS'}
        </a>
      ))}
    </span>
  );
}

/** "Checked by NCM SIR · Approved by NCM SIR" — once per distinct pair. */
export function Reviewers({ sources }: { sources: Pick<MisSourceDay, 'checkedBy' | 'approvedBy'>[] }) {
  const pairs = [...new Set(sources.map((s) => `${s.checkedBy ?? ''}|${s.approvedBy ?? ''}`))]
    .map((p) => p.split('|'))
    .filter(([c, a]) => c || a);
  if (!pairs.length) return null;
  return (
    <span className="text-[11px] text-gray-500">
      {pairs.map(([c, a], i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {c && <>Checked by <span className="font-medium text-gray-700 dark:text-gray-300">{c}</span></>}
          {c && a && ' · '}
          {a && <>Approved by <span className="font-medium text-gray-700 dark:text-gray-300">{a}</span></>}
        </span>
      ))}
    </span>
  );
}

/** Blank cells, e.g. "AA23 · 1k Intimation to Clients by Email". */
export function BlankList({ blanks, max = 8 }: { blanks: MisBlank[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? blanks : blanks.slice(0, max);
  return (
    <ul className="text-xs space-y-0.5">
      {shown.map((b) => (
        <li key={`${b.sheet}!${b.cell}`} className="flex gap-2">
          <span className="font-mono text-gray-400 w-12 shrink-0">{b.cell}</span>
          <span className="text-amber-800 dark:text-amber-300">{b.field}</span>
        </li>
      ))}
      {blanks.length > max && (
        <li>
          <button onClick={() => setAll(!all)} className="text-primary hover:underline">
            {all ? 'Show less' : `Show all ${blanks.length}`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** What the colours mean — shown on MIS Reports and the MIS staff screen. */
export function MisLegend({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const rows: { tone: Tone; title: string; text: string }[] = [
    { tone: 'green', title: 'Submitted', text: 'Every entry the person usually fills has something in that day’s column.' },
    {
      tone: 'amber',
      title: 'Incomplete',
      text: `The day was filled, but 1–${NOT_FILLED_BLANKS - 1} of their usual entries are blank. The exact cells are listed so they can be fixed.`,
    },
    {
      tone: 'red',
      title: 'Not submitted',
      text: `There is no column for that date, or ${NOT_FILLED_BLANKS} or more of their usual entries are blank.`,
    },
    { tone: 'gray', title: 'Grey', text: 'Day off (Sunday, 2nd/4th Saturday or holiday — not counted), or the file couldn’t be opened — the reason is shown.' },
  ];
  return (
    <div className="glass-card overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-3 flex items-center gap-2 text-left">
        <HelpCircle className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">How MIS is checked & what the colours mean</span>
        <span className="ml-auto flex items-center gap-1.5">
          {(['green', 'amber', 'red', 'gray'] as Tone[]).map((t) => (
            <span key={t} className={cn('w-2.5 h-2.5 rounded-full', TONE[t].dot)} />
          ))}
          <ChevronDown className={cn('w-4 h-4 text-gray-400 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 grid gap-4 md:grid-cols-2 text-sm">
          <ul className="space-y-2.5">
            {rows.map((r) => (
              <li key={r.title} className="flex gap-2.5">
                <span className={cn('mt-1.5 w-2.5 h-2.5 rounded-full shrink-0', TONE[r.tone].dot)} />
                <span>
                  <span className={cn('font-semibold', TONE[r.tone].text)}>{r.title}</span>
                  <span className="text-gray-600 dark:text-gray-400"> — {r.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <ul className="space-y-2 text-gray-600 dark:text-gray-400 list-disc pl-5">
            <li>
              MIS is checked <b>one working day late</b>: staff have until the end of the next working day to fill a day, so
              this page shows the <b>last working day</b> and the <b>one before it</b> — never today.
            </li>
            <li>
              <b>Days off</b> — Sundays, the 2nd and 4th Saturday, stock market (NSE) trading holidays and company holidays — need
              no MIS and are skipped (Monday after a 2nd-Saturday weekend shows Friday and Thursday).
            </li>
            <li>
              <b>Usual entries</b> are the rows a person filled on at least half of their last 10 working days. Rows they normally
              leave empty, section headings, and manager rows (Approved by / Remarks / Reply) are never counted.
            </li>
            <li>
              Anything typed counts as filled — <i>nil</i>, <i>NA</i>, <i>done</i>, a number. Only empty cells are blanks.
            </li>
            <li>Every file is re-read every 10 minutes, and again whenever this page is opened. Use “Re-check now” after a fix.</li>
            <li>
              Admins can pin exactly which rows are required per file in Employees → MIS staff → MIS files → Required fields.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
