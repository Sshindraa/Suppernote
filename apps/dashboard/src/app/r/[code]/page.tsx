import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const SHORT_CODE = /^[A-Za-z0-9]{8}$/;
const TOKEN = /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/;

async function resolveToken(code: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${process.env.API_URL || 'http://127.0.0.1:4000'}/public/reservation-short-link/${code}`,
      { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : undefined;
  } catch {
    return;
  }
}

export default async function ShortReservationPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const token = SHORT_CODE.test(code) ? await resolveToken(code) : undefined;
  // Le fragment n'est jamais envoyé au serveur : le token reste dans l'URL du navigateur.
  if (token) redirect(`/r#${token}`);
  return (
    <main className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">Ce lien n’est plus valide</h1>
      <p className="mt-3 text-muted-foreground">
        Pour modifier ou annuler votre réservation, utilisez le lien reçu par e-mail ou appelez le
        restaurant.
      </p>
    </main>
  );
}
