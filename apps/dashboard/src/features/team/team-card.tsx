'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Mail, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { useSiteSelection } from '@/features/sites/site-context';
import {
  INVITABLE_ROLES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  isInvitableRole,
  roleLabel,
  type InvitableRole,
} from './roles';

type Member = {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  isYou: boolean;
};

type Invitation = {
  id: string;
  email: string;
  role: InvitableRole | null;
  createdAt: string;
};

type Team = { members: Member[]; invitations: Invitation[] };

const selectClass =
  'h-10 rounded-md border border-input bg-background px-3 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

/**
 * Équipe du restaurant : inviter par e-mail avec un rôle, changer un rôle, retirer un membre.
 * Réservée au propriétaire (l'API refuse les autres), comme la gestion des établissements.
 */
export function TeamCard() {
  const { get, post, patch, del } = useApi();
  const { activeSite, status, refresh } = useSiteSelection();
  const isOwner = activeSite?.role === 'OWNER';

  const [team, setTeam] = useState<Team | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('STAFF');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [previousAccess, setPreviousAccess] = useState<'MANAGER' | 'READ_ONLY' | 'NONE'>('MANAGER');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setTeam(await get<Team>('team'));
    } catch (reason: unknown) {
      setLoadError(getErrorMessage(reason, 'Impossible de charger l’équipe.'));
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    if (isOwner) void load();
  }, [isOwner, load]);

  if (status === 'idle' || !isOwner) return null;

  async function run(id: string, action: () => Promise<unknown>, success: string) {
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await load();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason, 'L’action n’a pas abouti. Réessayez.'));
    } finally {
      setBusyId(null);
      setConfirmRemove(null);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address || inviting) return;
    setInviting(true);
    setError(null);
    setMessage(null);
    try {
      await post('team/invitations', { email: address, role });
      setEmail('');
      setMessage(`Invitation envoyée à ${address}.`);
      await load();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason, 'L’invitation n’a pas été envoyée.'));
    } finally {
      setInviting(false);
    }
  }

  return (
    <Card className="suppernote-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Users size={18} />
          Équipe
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Invitez vos collaborateurs et choisissez ce que chacun peut faire. Un rôle limite
          réellement l’accès, il ne se contente pas de masquer des pages.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {INVITABLE_ROLES.map((item) => (
            <li key={item} className="rounded-xl border border-border bg-secondary p-3">
              <p className="text-sm font-medium text-foreground">{ROLE_LABEL[item]}</p>
              <p className="mt-1 leading-5">{ROLE_DESCRIPTION[item]}</p>
            </li>
          ))}
        </ul>

        {loading && !team ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            Chargement de l’équipe…
          </p>
        ) : loadError && !team ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        ) : (
          <>
            <section aria-label="Membres" className="space-y-2">
              {team?.members.map((member) => {
                const editable = !member.isYou && member.role !== 'OWNER';
                const busy = busyId === member.userId;
                return (
                  <div
                    key={member.userId}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {member.name}
                        {member.isYou && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            (vous)
                          </span>
                        )}
                      </p>
                      {member.email && member.email !== member.name && (
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {editable ? (
                        <>
                          <select
                            aria-label={`Rôle de ${member.name}`}
                            value={isInvitableRole(member.role) ? member.role : ''}
                            disabled={busy}
                            onChange={(event) =>
                              void run(
                                member.userId,
                                () =>
                                  patch(`team/members/${member.userId}`, {
                                    role: event.target.value,
                                  }),
                                `Le rôle de ${member.name} a été modifié.`,
                              )
                            }
                            className={selectClass}
                          >
                            {!isInvitableRole(member.role) && <option value="">Aucun accès</option>}
                            {INVITABLE_ROLES.map((item) => (
                              <option key={item} value={item}>
                                {ROLE_LABEL[item]}
                              </option>
                            ))}
                          </select>
                          {confirmRemove === member.userId ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  member.userId,
                                  () => del(`team/members/${member.userId}`),
                                  `${member.name} ne fait plus partie de l’équipe.`,
                                )
                              }
                            >
                              {busy && <Loader2 className="animate-spin" />}
                              Confirmer le retrait
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => setConfirmRemove(member.userId)}
                            >
                              Retirer
                            </Button>
                          )}
                          {transferTo === member.userId ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <label htmlFor={`transfer-${member.userId}`} className="text-xs">
                                Votre accès après transfert
                              </label>
                              <select
                                id={`transfer-${member.userId}`}
                                value={previousAccess}
                                onChange={(event) =>
                                  setPreviousAccess(event.target.value as typeof previousAccess)
                                }
                                className={selectClass}
                                disabled={busy}
                              >
                                <option value="MANAGER">Responsable</option>
                                <option value="READ_ONLY">Lecture seule</option>
                                <option value="NONE">Aucun accès</option>
                              </select>
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setBusyId(member.userId);
                                  setError(null);
                                  void post('team/transfer-ownership', {
                                    targetUserId: member.userId,
                                    previousOwnerAccess: previousAccess,
                                  })
                                    .then(() => {
                                      setMessage(`La propriété a été transférée à ${member.name}.`);
                                      refresh();
                                    })
                                    .catch((reason: unknown) =>
                                      setError(
                                        getErrorMessage(reason, 'Le transfert n’a pas abouti.'),
                                      ),
                                    )
                                    .finally(() => setBusyId(null));
                                }}
                              >
                                Confirmer le transfert à {member.name}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setTransferTo(null)}
                              >
                                Annuler
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => setTransferTo(member.userId)}
                            >
                              Transférer la propriété
                            </Button>
                          )}
                        </>
                      ) : (
                        <span className="rounded-full bg-background px-3 py-1 text-xs font-medium">
                          {roleLabel(member.role)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>

            {team && team.invitations.length > 0 && (
              <section aria-label="Invitations en attente" className="space-y-2">
                <p className="text-sm font-medium">Invitations en attente</p>
                {team.invitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Mail
                        size={15}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm">{invitation.email}</span>
                      <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-xs">
                        {roleLabel(invitation.role)}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyId === invitation.id}
                      onClick={() =>
                        void run(
                          invitation.id,
                          () => del(`team/invitations/${invitation.id}`),
                          'Invitation annulée.',
                        )
                      }
                    >
                      {busyId === invitation.id && <Loader2 className="animate-spin" />}
                      Annuler l’invitation
                    </Button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        <form onSubmit={handleInvite} className="space-y-3 border-t border-border pt-5">
          <p className="text-sm font-medium">Inviter quelqu’un</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Adresse e-mail"
              aria-label="Adresse e-mail à inviter"
              required
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as InvitableRole)}
              aria-label="Rôle de la personne invitée"
              className={selectClass}
            >
              {INVITABLE_ROLES.map((item) => (
                <option key={item} value={item}>
                  {ROLE_LABEL[item]}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={inviting || !email.trim()}>
            {inviting ? <Loader2 className="animate-spin" /> : <UserPlus />}
            {inviting ? 'Envoi…' : 'Envoyer l’invitation'}
          </Button>
        </form>

        {message && (
          <p className="flex items-center gap-2 text-sm text-primary">
            <CheckCircle2 size={16} aria-hidden="true" />
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle size={16} aria-hidden="true" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
