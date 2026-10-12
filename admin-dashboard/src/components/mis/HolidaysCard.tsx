'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Loader2, Plus, RotateCcw } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { dmy, useHolidays } from '@/components/mis/circleApi';

/** NSE trading holidays + company holidays; weekly offs are fixed (Sundays, 2nd Saturday). */
export function HolidaysCard({ year, canEdit, defaultOpen = false }: { year: number; canEdit: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const { data, isLoading } = useHolidays(year);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['mis-holidays'] });
    qc.invalidateQueries({ queryKey: ['mis-circle'] });
    qc.invalidateQueries({ queryKey: ['msi-admin'] });
    qc.invalidateQueries({ queryKey: ['mis-sources'] });
  };
  const set = useMutation({
    mutationFn: (b: { date: string; name?: string | null; isOff: boolean }) => api.put('/mis/holidays', b),
    onSuccess: () => {
      setDate('');
      setName('');
      refresh();
    },
  });
  const reset = useMutation({ mutationFn: (d: string) => api.delete(`/mis/holidays/${d}`), onSuccess: refresh });
  const list = data?.holidays ?? [];
  const off = list.filter((h) => h.isOff).length;
  return (
    <div id="holidays" className="glass-card overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-3 flex items-center gap-2 text-left">
        <CalendarOff className="w-4 h-4 text-gray-500" />
        <span className="text-sm font-semibold">Days off {year} — no MIS needed</span>
        <span className="text-xs text-gray-500">
          Sundays · 2nd Saturday · {isLoading ? '…' : `${off} holidays`}
        </span>
        <span className="ml-auto text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3">
          <p className="text-xs text-gray-500">
            On these days no MIS is needed: they are never red circles and the MIS pages skip them (they show the last working days instead). Stock market
            holidays come from the {data?.source ?? 'NSE circular'}. Add your company's own holidays below, or switch off a market holiday the office works on.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-400 text-left">
                <tr>
                  <th className="py-1.5 font-medium">Date</th>
                  <th className="py-1.5 font-medium">Day</th>
                  <th className="py-1.5 font-medium">Holiday</th>
                  <th className="py-1.5 font-medium">From</th>
                  <th className="py-1.5 font-medium">Status</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {list.map((h) => (
                  <tr key={h.date} className={cn('border-t border-gray-100 dark:border-gray-900', !h.isOff && 'text-gray-400 line-through')}>
                    <td className="py-1.5 whitespace-nowrap">{dmy(h.date)}</td>
                    <td className="py-1.5">{h.weekday}</td>
                    <td className="py-1.5">{h.name}</td>
                    <td className="py-1.5">{h.source === 'NSE' ? 'Stock market (NSE)' : 'Company'}</td>
                    <td className="py-1.5 no-underline">{h.isOff ? 'Off — no MIS' : 'Working day'}</td>
                    {canEdit && (
                      <td className="py-1.5 text-right">
                        {h.source === 'NSE' && h.isOff && (
                          <button onClick={() => set.mutate({ date: h.date, isOff: false })} className="text-gray-500 hover:text-red-600" title="The office works on this day — MIS needed">
                            Make working day
                          </button>
                        )}
                        {(h.source === 'COMPANY' || !h.isOff) && (
                          <button onClick={() => reset.mutate(h.date)} className="inline-flex items-center gap-1 text-gray-500 hover:text-primary" title={h.source === 'NSE' ? 'Back to holiday' : 'Remove'}>
                            <RotateCcw className="w-3 h-3" /> {h.source === 'NSE' ? 'Undo' : 'Remove'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {!isLoading && list.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-gray-500">
                      No holidays listed for {year} yet — NSE publishes them around mid-December. Add them below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (date) set.mutate({ date, name: name.trim() || null, isOff: true });
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg text-sm bg-transparent" />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Holiday name, e.g. Office Diwali puja"
                className="px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg text-sm bg-transparent w-64"
              />
              <button type="submit" disabled={!date || set.isPending} className="btn-secondary text-sm flex items-center gap-1.5">
                {set.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add holiday
              </button>
              {(set.isError || reset.isError) && <span className="text-xs text-red-600">Could not save.</span>}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
