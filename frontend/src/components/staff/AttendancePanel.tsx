'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { parseDbTimestamp } from '@/lib/utils';

interface AttendanceEntry {
  id: number;
  business_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  hours: number;
  wage: number;
  corrected: boolean;
}

interface AttendanceStaff {
  user_id: string;
  name: string;
  role: string;
  hourly_rate: number | null;
  total_hours: number;
  total_wage: number;
  open_shifts: number;
  entries: AttendanceEntry[];
}

interface AttendanceReport {
  from: string;
  to: string;
  timezone: string;
  staff: AttendanceStaff[];
}

/** Store-local `YYYY-MM-DDTHH:mm` for a stored UTC timestamp, as a datetime-local input wants it. */
function toStoreLocalInput(stamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parseDbTimestamp(stamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Worked hours from first sign-in to sign-out, and the wage at each person's hourly rate. */
export function AttendancePanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const money = useFormatCurrency();
  const { formatDate, formatTime } = useFormatDate();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: number; clockIn: string; clockOut: string } | null>(null);

  const apply = useCallback((data: AttendanceReport) => {
    // A malformed reply leaves the panel empty rather than taking the staff page down.
    if (!Array.isArray(data?.staff)) return;
    setReport(data);
    setRange({ from: data.from, to: data.to });
    setRates(
      Object.fromEntries(data.staff.map((member) => [member.user_id, member.hourly_rate == null ? '' : String(member.hourly_rate)])),
    );
  }, []);

  const load = useCallback(async (next?: { from: string; to: string }) => {
    try {
      const { data } = await api.get<AttendanceReport>('/attendance', { params: next });
      apply(data);
    } catch {
      toast.error(t('attendanceLoadFailed'));
    }
  }, [apply, t]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AttendanceReport>('/attendance')
      .then(({ data }) => {
        if (!cancelled) apply(data);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('attendanceLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [apply, t]);

  const saveRate = async (member: AttendanceStaff) => {
    const value = rates[member.user_id] ?? '';
    if (value === (member.hourly_rate == null ? '' : String(member.hourly_rate))) return;
    try {
      await api.put(`/attendance/rates/${member.user_id}`, { hourly_rate: value === '' ? null : Number(value) });
      toast.success(t('rateSaved'));
      await load(range ?? undefined);
    } catch {
      toast.error(t('attendanceSaveFailed'));
    }
  };

  const saveShift = async () => {
    if (!editing) return;
    try {
      await api.put(`/attendance/${editing.id}`, { clock_in: editing.clockIn, clock_out: editing.clockOut || null });
      toast.success(t('shiftSaved'));
      setEditing(null);
      await load(range ?? undefined);
    } catch {
      toast.error(t('attendanceSaveFailed'));
    }
  };

  const grandHours = report?.staff.reduce((sum, member) => sum + member.total_hours, 0) ?? 0;
  const grandWage = report?.staff.reduce((sum, member) => sum + member.total_wage, 0) ?? 0;
  const timeOf = (stamp: string) => formatTime(stamp, { hourCycle: 'h23' });

  return (
    <section data-testid="attendance-panel" className="bg-card rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold text-foreground">{t('attendanceTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('attendanceHint')}</p>
        </div>
        {range && (
          <div className="flex items-end gap-2">
            <label className="text-xs text-muted-foreground">
              {t('attendanceFrom')}
              <input
                type="date"
                data-testid="attendance-from"
                value={range.from}
                max={range.to}
                onChange={(e) => e.target.value && void load({ from: e.target.value, to: range.to })}
                className="block mt-1 px-2 py-1.5 border border-border rounded-lg bg-background text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              {t('attendanceTo')}
              <input
                type="date"
                data-testid="attendance-to"
                value={range.to}
                min={range.from}
                onChange={(e) => e.target.value && void load({ from: range.from, to: e.target.value })}
                className="block mt-1 px-2 py-1.5 border border-border rounded-lg bg-background text-sm text-foreground"
              />
            </label>
          </div>
        )}
      </div>

      {report && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs text-muted-foreground border-b border-border">
                <th className="py-2 text-start font-medium">{t('attendanceStaff')}</th>
                <th className="py-2 text-end font-medium">{t('attendanceHours')}</th>
                <th className="py-2 text-end font-medium">{t('attendanceRate')}</th>
                <th className="py-2 text-end font-medium">{t('attendanceWage')}</th>
              </tr>
            </thead>
            <tbody>
              {report.staff.map((member) => (
                <Fragment key={member.user_id}>
                  <tr data-testid={`attendance-row-${member.user_id}`} className="border-b border-border">
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === member.user_id ? null : member.user_id)}
                        className="flex items-center gap-1 font-medium text-foreground"
                      >
                        {expanded === member.user_id ? <ChevronDown size={14} /> : <ChevronRight size={14} className="rtl-flip" />}
                        {member.name}
                      </button>
                      {member.open_shifts > 0 && (
                        <span className="ms-5 text-xs text-amber-600">{t('attendanceOpenShifts', { count: member.open_shifts })}</span>
                      )}
                    </td>
                    <td className="py-2 text-end tabular-nums" data-testid="attendance-hours">{member.total_hours.toFixed(2)}</td>
                    <td className="py-2 text-end">
                      {canManage ? (
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          aria-label={t('attendanceRateFor', { name: member.name })}
                          data-testid="attendance-rate"
                          value={rates[member.user_id] ?? ''}
                          onChange={(e) => setRates({ ...rates, [member.user_id]: e.target.value })}
                          onBlur={() => void saveRate(member)}
                          className="w-24 px-2 py-1 border border-border rounded-lg bg-background text-end tabular-nums"
                        />
                      ) : member.hourly_rate == null ? (
                        '—'
                      ) : (
                        money(member.hourly_rate)
                      )}
                    </td>
                    <td className="py-2 text-end font-semibold tabular-nums" data-testid="attendance-wage">
                      {money(member.total_wage)}
                    </td>
                  </tr>
                  {expanded === member.user_id && (
                    <tr>
                      <td colSpan={4} className="bg-muted/40 px-3 py-2">
                        {member.entries.length === 0 ? (
                          <p className="text-xs text-muted-foreground">{t('attendanceNoShifts')}</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-muted-foreground">
                                <th className="py-1 text-start font-medium">{t('attendanceDate')}</th>
                                <th className="py-1 text-start font-medium">{t('attendanceIn')}</th>
                                <th className="py-1 text-start font-medium">{t('attendanceOut')}</th>
                                <th className="py-1 text-end font-medium">{t('attendanceHours')}</th>
                                <th className="py-1 text-end font-medium">{t('attendanceWage')}</th>
                                {canManage && <th />}
                              </tr>
                            </thead>
                            <tbody>
                              {member.entries.map((entry) =>
                                editing?.id === entry.id ? (
                                  <tr key={entry.id}>
                                    <td className="py-1">{formatDate(`${entry.business_date}T00:00:00Z`, { timeZone: 'UTC' })}</td>
                                    <td className="py-1">
                                      <input
                                        type="datetime-local"
                                        aria-label={t('attendanceIn')}
                                        value={editing.clockIn}
                                        onChange={(e) => setEditing({ ...editing, clockIn: e.target.value })}
                                        className="px-1 py-0.5 border border-border rounded bg-background"
                                      />
                                    </td>
                                    <td className="py-1">
                                      <input
                                        type="datetime-local"
                                        aria-label={t('attendanceOut')}
                                        value={editing.clockOut}
                                        onChange={(e) => setEditing({ ...editing, clockOut: e.target.value })}
                                        className="px-1 py-0.5 border border-border rounded bg-background"
                                      />
                                    </td>
                                    <td colSpan={canManage ? 3 : 2} className="py-1 text-end">
                                      <Button size="sm" onClick={() => void saveShift()} className="me-1">
                                        {tCommon('save')}
                                      </Button>
                                      <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                                        {tCommon('cancel')}
                                      </Button>
                                    </td>
                                  </tr>
                                ) : (
                                  <tr key={entry.id} data-testid="attendance-entry">
                                    <td className="py-1">{formatDate(`${entry.business_date}T00:00:00Z`, { timeZone: 'UTC' })}</td>
                                    <td className="py-1 tabular-nums">{timeOf(entry.clock_in_at)}</td>
                                    <td className="py-1 tabular-nums">
                                      {entry.clock_out_at ? (
                                        timeOf(entry.clock_out_at)
                                      ) : (
                                        <span className="text-amber-600">{t('attendanceStillWorking')}</span>
                                      )}
                                      {entry.corrected && (
                                        <span className="ms-1 text-muted-foreground">({t('attendanceCorrected')})</span>
                                      )}
                                    </td>
                                    <td className="py-1 text-end tabular-nums">{entry.hours.toFixed(2)}</td>
                                    <td className="py-1 text-end tabular-nums">{money(entry.wage)}</td>
                                    {canManage && (
                                      <td className="py-1 text-end">
                                        <button
                                          type="button"
                                          aria-label={tCommon('edit')}
                                          onClick={() =>
                                            setEditing({
                                              id: entry.id,
                                              clockIn: toStoreLocalInput(entry.clock_in_at, report.timezone),
                                              clockOut: entry.clock_out_at
                                                ? toStoreLocalInput(entry.clock_out_at, report.timezone)
                                                : '',
                                            })
                                          }
                                          className="p-1 text-muted-foreground hover:text-foreground"
                                        >
                                          <Pencil size={14} />
                                        </button>
                                      </td>
                                    )}
                                  </tr>
                                ),
                              )}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold text-foreground">
                <td className="py-2">{tCommon('total')}</td>
                <td className="py-2 text-end tabular-nums">{grandHours.toFixed(2)}</td>
                <td />
                <td className="py-2 text-end tabular-nums" data-testid="attendance-grand-wage">
                  {money(grandWage)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
