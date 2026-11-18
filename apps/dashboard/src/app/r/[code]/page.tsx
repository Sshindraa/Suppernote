import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const SHORT_CODE = /^[A-Za-z0-9]{8}$/;
const TOKEN = /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/;

type Resolution = { token?: string; rateLimited: boolean };

async function resolveToken(code: string): Promise<Resolution> {
  // Sans l'IP du visiteur, la limite de l'API compte tous les visiteurs comme 127.0.0.1.
  const incoming = await headers();
  const forwardedFor = incoming.get('x-forwarded-for');
  const requestId = incoming.get('x-request-id');
  try {
    const response = await fetch(
      `${process.env.API_URL || 'http://127.0.0.1:4000'}/public/reservation-short-link/${code}`,
      {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
      },
    );
    if (response.status === 429) return { rateLimited: true };
    if (!response.ok) return { rateLimited: false };
    const body = (await response.json()) as { token?: unknown };
    const token = typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : undefined;
    return { token, rateLimited: false };
  } catch {
    return { rateLimited: false };
  }
}

export default async function ShortReservationPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const resolution = SHORT_CODE.test(code) ? await resolveToken(code) : { rateLimited: false };
  // Le fragment n'est jamais envoyé au serveur : le token reste dans l'URL du navigateur.
  if (resolution.token) redirect(`/r#${resolution.token}`);
  return (
    <main className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">
        {resolution.rateLimited
          ? 'Trop de tentatives, veuillez réessayer dans une minute.'
          : 'Ce lien n’est plus valide'}
      </h1>
      <p className="mt-3 text-muted-foreground">
        Pour modifier ou annuler votre réservation, utilisez le lien reçu par e-mail ou appelez le
        restaurant.
      </p>
    </main>
  );
}
