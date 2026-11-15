'use client';

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const day = (value: string) => new Date(`${value}T12:00:00`);
const monthKey = (date: Date) => iso(date).slice(0, 7);
const fullDate = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function ReservationDatePicker({
  value,
  min,
  max,
  onChange,
  theme,
  label,
  openAt,
}: {
  value: string | null;
  min: string;
  max: string;
  onChange: (value: string) => void;
  theme: CSSProperties;
  /** Plain-text trigger (e.g. the month in view) instead of the date pill. */
  label?: string;
  /** Month shown on open, when it differs from the selected date's. */
  openAt?: string;
}) {
  const clamp = (value: string) => (value < min ? min : value > max ? max : value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => day(clamp(value ?? min)));
  const [focused, setFocused] = useState(clamp(value ?? min));
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const dates = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, i) => {
      const date = new Date(first);
      date.setDate(1 - offset + i);
      return date;
    });
  }, [month]);
  const title = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(month);
  const focusStyle =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--reservation-accent))] focus-visible:ring-offset-2';
  function showMonth(offset: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1, 12);
    setMonth(next);
    setFocused(clamp(iso(next)));
  }
  function move(event: KeyboardEvent<HTMLButtonElement>, date: Date) {
    const shifts: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -(date.getDay() + 6) % 7,
      End: 6 - ((date.getDay() + 6) % 7),
    };
    const next = new Date(date);
    if (event.key in shifts) next.setDate(next.getDate() + shifts[event.key]);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const targetMonth = next.getMonth() + (event.key === 'PageUp' ? -1 : 1);
      const number = next.getDate();
      next.setDate(1);
      next.setMonth(targetMonth);
      next.setDate(
        Math.min(number, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()),
      );
    } else return;
    event.preventDefault();
    const target = clamp(iso(next));
    if (monthKey(day(target)) !== monthKey(month)) setMonth(day(target));
    setFocused(target);
    requestAnimationFrame(() => cells.current.get(target)?.focus());
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Choisir une date dans le calendrier"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            const initial = clamp(openAt ?? value ?? min);
            setMonth(day(initial));
            setFocused(initial);
          }}
          className={cn(
            label
              ? 'inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-sm font-bold text-[hsl(var(--reservation-ink))] transition-all duration-200 hover:bg-[hsl(var(--reservation-line)/0.5)]'
              : 'inline-flex min-h-11 items-center gap-2 rounded-full border border-[hsl(var(--reservation-line))] bg-[hsl(var(--reservation-panel)/0.65)] px-3 text-xs font-semibold text-[hsl(var(--reservation-ink))] transition-all duration-200 hover:bg-[hsl(var(--reservation-panel))]',
            focusStyle,
          )}
        >
          {!label && <CalendarDays size={14} aria-hidden="true" />}
          {label ??
            (value
              ? new Intl.DateTimeFormat('fr-FR', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }).format(day(value))
              : 'Autre date')}
          <ChevronDown size={label ? 15 : 13} aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent
        style={theme}
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-sm"
        className="w-[calc(100vw-2rem)] max-w-sm gap-3 overflow-y-auto rounded-3xl border-[hsl(var(--reservation-line))] bg-[hsl(var(--reservation-wash))] p-4 text-[hsl(var(--reservation-ink))] shadow-xl sm:rounded-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cells.current.get(focused)?.focus();
        }}
      >
        <DialogTitle className="sr-only">Choisir une date</DialogTitle>
        <DialogDescription className="sr-only">
          Choisissez un jour. Les disponibilités seront vérifiées pour cette date.
        </DialogDescription>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            aria-label="Mois précédent"
            disabled={monthKey(month) <= min.slice(0, 7)}
            onClick={() => showMonth(-1)}
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200 hover:bg-[hsl(var(--reservation-line)/0.5)] disabled:opacity-25',
              focusStyle,
            )}
          >
            <ChevronLeft size={18} />
          </button>
          <p aria-live="polite" className="text-base font-semibold capitalize">
            {title}
          </p>
          <button
            type="button"
            aria-label="Mois suivant"
            disabled={monthKey(month) >= max.slice(0, 7)}
            onClick={() => showMonth(1)}
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200 hover:bg-[hsl(var(--reservation-line)/0.5)] disabled:opacity-25',
              focusStyle,
            )}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div role="grid" aria-label={title}>
          <div role="row" className="mb-2 grid grid-cols-7">
            {['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'].map((name) => (
              <div
                role="columnheader"
                key={name}
                className="py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--reservation-soft))]"
              >
                {name}
              </div>
            ))}
          </div>
          {Array.from({ length: dates.length / 7 }, (_, row) => (
            <div role="row" key={row} className="grid grid-cols-7">
              {dates.slice(row * 7, row * 7 + 7).map((date) => {
                const key = iso(date);
                const disabled = key < min || key > max;
                const selected = key === value;
                const outside = monthKey(date) !== monthKey(month);
                return (
                  <div role="gridcell" aria-selected={selected} key={key}>
                    <button
                      type="button"
                      ref={(node) => {
                        if (node) cells.current.set(key, node);
                        else cells.current.delete(key);
                      }}
                      tabIndex={!disabled && focused === key ? 0 : -1}
                      aria-label={fullDate.format(date)}
                      aria-pressed={selected}
                      disabled={disabled}
                      onFocus={() => setFocused(key)}
                      onKeyDown={(event) => move(event, date)}
                      onClick={() => {
                        onChange(key);
                        setOpen(false);
                      }}
                      className={cn(
                        'my-0.5 flex h-11 w-full items-center justify-center rounded-xl text-sm font-medium transition-all duration-200 disabled:cursor-default disabled:opacity-25',
                        focusStyle,
                        selected
                          ? 'bg-[hsl(var(--reservation-ink))] font-semibold text-[hsl(var(--reservation-panel))]'
                          : 'hover:bg-[hsl(var(--reservation-line)/0.6)]',
                        !selected && outside && 'text-[hsl(var(--reservation-muted))]',
                        !selected && key === min && 'border border-[hsl(var(--reservation-line))]',
                      )}
                    >
                      {date.getDate()}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cn(
            'min-h-11 rounded-full border border-[hsl(var(--reservation-line))] text-xs font-medium text-[hsl(var(--reservation-soft))] transition-all duration-200 hover:bg-[hsl(var(--reservation-panel)/0.65)]',
            focusStyle,
          )}
        >
          Fermer le calendrier
        </button>
      </DialogContent>
    </Dialog>
  );
}
