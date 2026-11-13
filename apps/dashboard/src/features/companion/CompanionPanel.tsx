'use client';

import Link from 'next/link';
import { parisToday } from '@/lib/paris-date';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowUp, Loader2, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-error';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TonightCard } from './TonightCard';
import { isCampaignDraft, storeCampaignDraft, type CompanionCampaignDraft } from './campaign-draft';

const MAX_CHARS = 4000;
/** Nombre de messages renvoyés au modèle à chaque question : l'historique complet reste affiché. */
const SENT_HISTORY = 20;

interface Source {
  tool: string;
  href: string;
}

type Rating = 'up' | 'down';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  /** Absent sur les réponses enregistrées avant les avis : elles n'ont pas de boutons. */
  responseId?: string;
  rating?: Rating;
  /** Brouillon de relance, présent seulement si Companion en a rédigé un. */
  draft?: CompanionCampaignDraft;
}

interface CompanionReply {
  reply: string;
  sources: Source[];
  responseId: string;
  draft?: CompanionCampaignDraft | null;
}

const SUGGESTION_KEYS = ['week', 'noShows', 'bookings'] as const;

function historyKey(siteId: string): string {
  return `suppernote.companion.${siteId}`;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return (
    (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
  );
}

/** Le stockage de session peut être refusé (navigation privée, quota) : la conversation reste alors en mémoire. */
function readHistory(siteId: string): Message[] {
  try {
    const raw = window.sessionStorage.getItem(historyKey(siteId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Les champs en trop d'une version antérieure (comme toolRuns) sont ignorés.
    return Array.isArray(parsed)
      ? parsed.filter(isMessage).map(({ role, content, sources, responseId, rating, draft }) => ({
          role,
          content,
          sources,
          responseId,
          rating,
          draft: isCampaignDraft(draft) ? draft : undefined,
        }))
      : [];
  } catch {
    return [];
  }
}

function writeHistory(siteId: string, messages: Message[]): void {
  try {
    if (messages.length === 0) window.sessionStorage.removeItem(historyKey(siteId));
    else window.sessionStorage.setItem(historyKey(siteId), JSON.stringify(messages));
  } catch {
    // Pas de persistance : la conversation reste visible jusqu'au rechargement.
  }
}

/** Une seule ligne par page du dashboard : plusieurs outils renvoient le même écran. */
function uniqueSources(sources: Source[]): Source[] {
  return sources.filter(
    (source, index) => sources.findIndex((other) => other.href === source.href) === index,
  );
}

/** Une conversation par site : le panneau est recréé quand le site change. */
export function CompanionPanel() {
  const { siteId } = useApi();
  return <CompanionConversation key={siteId ?? 'no-site'} siteId={siteId} />;
}

function CompanionConversation({ siteId }: { siteId: string | undefined }) {
  const t = useTranslations('companion');
  const tFill = useTranslations('fillService');
  const { post } = useApi();
  const [messages, setMessages] = useState<Message[]>(() => (siteId ? readHistory(siteId) : []));
  const [draft, setDraft] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Le dernier message reste visible, réponse ou erreur comprise.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, pending, error]);

  // Chaque changement est enregistré, avis compris.
  useEffect(() => {
    if (siteId) writeHistory(siteId, messages);
  }, [messages, siteId]);

  /** Met à jour l'avis d'une réponse par son identifiant, sans dépendre de l'état au moment du clic. */
  function setRating(responseId: string, rating: Rating | undefined) {
    setMessages((previous) =>
      previous.map((message) =>
        message.responseId === responseId ? { ...message, rating } : message,
      ),
    );
  }

  async function rate(responseId: string, rating: Rating) {
    setRating(responseId, rating);
    try {
      await post('companion/feedback', { responseId, rating });
    } catch {
      // Avis non enregistré : silencieux, les boutons redeviennent disponibles.
      setRating(responseId, undefined);
    }
  }

  async function request(history: Message[]) {
    setPending(true);
    setError(null);
    try {
      const body = {
        messages: history.slice(-SENT_HISTORY).map(({ role, content }) => ({ role, content })),
      };
      const reply = await post<CompanionReply>('companion/chat', body);
      // Mise à jour fonctionnelle : un avis donné pendant l'attente reste dans la liste.
      setMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          content: reply.reply,
          sources: uniqueSources(reply.sources),
          responseId: reply.responseId,
          draft: reply.draft ?? undefined,
        },
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('genericError'));
    } finally {
      setPending(false);
    }
  }

  function ask(question: string) {
    const text = question.trim();
    if (!text || pending) return;
    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    void request(next);
  }

  function startNewConversation() {
    setMessages([]);
    setError(null);
    setDraft('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    ask(draft);
  }

  // Ouvre l'éditeur de campagne avec le brouillon : il passe par la session, jamais par l'URL.
  function draftLink(draft: CompanionCampaignDraft) {
    const linkClass =
      'mt-2 inline-block text-xs font-medium text-primary underline-offset-4 transition-all duration-200 hover:underline';
    return (
      <div className="flex flex-wrap gap-x-4">
        <Link
          href="/dashboard/marketing/campaigns/new"
          onClick={() => storeCampaignDraft(draft)}
          className={linkClass}
        >
          {t('openCampaign')}
        </Link>
        {/* Service du soir d'aujourd'hui, à Paris : le gérant peut changer le jour et le service sur la page. */}
        <Link
          href={`/dashboard/marketing/fill-service?date=${parisToday()}&service=soir`}
          onClick={() => storeCampaignDraft(draft)}
          className={linkClass}
        >
          {tFill('openFromQuietDay')}
        </Link>
      </div>
    );
  }

  function feedbackButtons(responseId: string, rating: Rating | undefined) {
    const rated = rating !== undefined;
    const buttonClass = (chosen: boolean) =>
      cn('h-7 w-7 transition-all duration-200', chosen && 'text-primary disabled:opacity-100');
    return (
      <div className="mt-2 flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t('helpful')}
          aria-label={t('helpful')}
          aria-pressed={rating === 'up'}
          disabled={rated}
          onClick={() => void rate(responseId, 'up')}
          className={buttonClass(rating === 'up')}
        >
          <ThumbsUp size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t('unhelpful')}
          aria-label={t('unhelpful')}
          aria-pressed={rating === 'down'}
          disabled={rated}
          onClick={() => void rate(responseId, 'down')}
          className={buttonClass(rating === 'down')}
        >
          <ThumbsDown size={14} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {messages.length > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={startNewConversation}
            disabled={pending}
            className="text-xs text-muted-foreground"
          >
            <RotateCcw size={14} />
            {t('newConversation')}
          </Button>
        </div>
      )}

      <div
        ref={threadRef}
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {messages.length === 0 ? (
          <div className="space-y-3">
            <TonightCard />
            <div className="flex flex-col gap-2">
              {SUGGESTION_KEYS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  onClick={() => ask(t(`suggestions.${key}`))}
                  disabled={pending}
                  className="h-auto justify-start whitespace-normal py-2 text-left text-sm font-normal transition-all duration-200"
                >
                  {t(`suggestions.${key}`)}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={cn(
                'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                message.role === 'user'
                  ? 'ml-auto bg-primary text-primary-foreground'
                  : 'border border-border bg-background text-foreground',
              )}
            >
              <p className="whitespace-pre-line">{message.content}</p>
              {uniqueSources(message.sources ?? []).map((source) => (
                <Link
                  key={source.href}
                  href={source.href}
                  className="mt-2 inline-block text-xs font-medium text-primary underline-offset-4 transition-all duration-200 hover:underline"
                >
                  {t('openSource')}
                </Link>
              ))}
              {message.role === 'assistant' && message.draft && draftLink(message.draft)}
              {message.role === 'assistant' &&
                message.responseId &&
                feedbackButtons(message.responseId, message.rating)}
            </div>
          ))
        )}

        {pending && (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('thinking')}
          </div>
        )}

        {error && (
          <div role="alert" className="space-y-2 rounded-xl border border-border bg-background p-3">
            <p className="text-sm text-foreground">{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void request(messages)}
              className="transition-all duration-200"
            >
              {t('retry')}
            </Button>
          </div>
        )}
      </div>

      <form
        className={cn(
          'flex gap-2 border border-border bg-primary p-1.5 text-primary-foreground shadow-sm transition-all duration-200 focus-within:ring-2 focus-within:ring-ring',
          inputFocused || draft ? 'flex-col rounded-2xl' : 'items-center rounded-full',
        )}
        onSubmit={(event) => {
          event.preventDefault();
          ask(draft);
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onKeyDown={onKeyDown}
          disabled={pending}
          maxLength={MAX_CHARS}
          rows={inputFocused || draft ? 3 : 1}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          className="min-h-9 w-full flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm text-primary-foreground placeholder:text-primary-foreground/65 focus:outline-none disabled:opacity-60"
        />
        <Button
          type="submit"
          size="icon"
          disabled={pending || draft.trim().length === 0}
          aria-label={t('send')}
          title={t('send')}
          className="h-9 w-9 shrink-0 self-end rounded-full bg-primary-foreground text-primary transition-all duration-200 hover:bg-primary-foreground/85 disabled:opacity-50"
        >
          <ArrowUp size={16} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
