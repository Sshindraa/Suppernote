import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

// Le setup global moque le SDK Telnyx, Redis et BullMQ. Ce test vérifie la vraie signature
// du webhook et la vraie file d'attente : on les rétablit donc ici.
vi.unmock('@prisma/client');
vi.unmock('telnyx');
vi.unmock('ioredis');
vi.unmock('bullmq');

// Clé Ed25519 générée pour le test : le garde Telnyx la vérifie pour de vrai.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

type App = Awaited<ReturnType<typeof import('../../../main').buildApp>>;
type Db = typeof import('../../../shared/db/client').db;

/**
 * Un site suspendu ou archivé ne doit jamais décrocher l'appel : Suppernote renvoie `ok`
 * sans demander à Telnyx de répondre. Le témoin « actif » prouve que le compteur détecte bien
 * un décrochage, sinon le test « aucune requête » ne prouverait rien.
 *
 * Exécuté par le job « API integration (Postgres) » (AGENTIC_INT_TESTS=1) : base et Redis jetables.
 */
describe.skipIf(process.env.AGENTIC_INT_TESTS !== '1')(
  'appel entrant et statut du site — PostgreSQL, Redis et signature réels',
  () => {
    let app: App;
    let db: Db;
    let telnyxServer: Server;
    const telnyxRequests: string[] = [];

    const randomPhone = () => `+339${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

    async function seedRestaurant(siteStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
      const phoneNumber = randomPhone();
      await db.restaurant.create({
        data: {
          name: `Test ${siteStatus}`,
          slug: `int-site-${siteStatus.toLowerCase()}-${randomUUID()}`,
          managerPhone: '+33100000000',
          managerEmail: `int-${randomUUID()}@example.invalid`,
          phoneNumber,
          openingHours: {},
          siteStatus,
        },
      });
      return phoneNumber;
    }

    async function callInitiated(to: string) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        data: {
          event_type: 'call.initiated',
          id: randomUUID(),
          occurred_at: new Date().toISOString(),
          payload: {
            call_control_id: `int-${randomUUID()}`,
            call_leg_id: randomUUID(),
            call_session_id: randomUUID(),
            connection_id: 'int-connection',
            direction: 'incoming',
            from: '+33600000001',
            to,
            state: 'parked',
          },
        },
      });
      const signature = sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), privateKey);
      return app.inject({
        method: 'POST',
        url: '/voice/telnyx',
        headers: {
          'content-type': 'application/json',
          'telnyx-signature-ed25519': signature.toString('base64'),
          'telnyx-timestamp': timestamp,
        },
        payload: body,
      });
    }

    const answerRequests = () => telnyxRequests.filter((line) => line.includes('/actions/answer'));

    beforeAll(async () => {
      telnyxServer = createServer((req, res) => {
        telnyxRequests.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":{}}');
      });
      await new Promise<void>((resolve) => telnyxServer.listen(0, '127.0.0.1', () => resolve()));
      const { port } = telnyxServer.address() as AddressInfo;

      // Lues à l'import : à poser avant de charger l'application.
      process.env.TELNYX_API_URL = `http://127.0.0.1:${port}`;
      process.env.TELNYX_API_KEY = 'test-telnyx-key';
      process.env.TELNYX_PUBLIC_KEY = rawPublicKey.toString('base64');
      // Le setup global fournit une clé Clerk factice que le plugin refuse : format valide ici.
      process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('clerk.example.accounts.dev$').toString('base64')}`;

      ({ db } = await import('../../../shared/db/client'));
      const { buildApp } = await import('../../../main');
      app = await buildApp();
      await app.ready();
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await new Promise<void>((resolve) => telnyxServer?.close(() => resolve()));
    });

    it.each(['SUSPENDED', 'ARCHIVED'] as const)(
      'ne décroche pas un site %s : réponse ok, aucune requête de décrochage',
      async (siteStatus) => {
        const phone = await seedRestaurant(siteStatus);
        const before = answerRequests().length;

        const res = await callInitiated(phone);
        await new Promise((resolve) => setTimeout(resolve, 1500));

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ result: 'ok' });
        expect(answerRequests().length).toBe(before);
      },
    );

    it('décroche un site actif (témoin : le compteur détecte bien un décrochage)', async () => {
      const phone = await seedRestaurant('ACTIVE');
      const before = answerRequests().length;

      const res = await callInitiated(phone);
      const deadline = Date.now() + 10_000;
      while (answerRequests().length === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(res.statusCode).toBe(200);
      expect(answerRequests().length).toBeGreaterThan(before);
    });

    it('rejette un webhook dont la signature ne correspond pas au corps', async () => {
      const phone = await seedRestaurant('ACTIVE');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        data: {
          event_type: 'call.initiated',
          payload: { call_control_id: `int-${randomUUID()}`, to: phone, from: '+33600000001' },
        },
      });
      const signature = sign(null, Buffer.from(`${timestamp}|${body}altéré`, 'utf8'), privateKey);

      const res = await app.inject({
        method: 'POST',
        url: '/voice/telnyx',
        headers: {
          'content-type': 'application/json',
          'telnyx-signature-ed25519': signature.toString('base64'),
          'telnyx-timestamp': timestamp,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(403);
    });
  },
);
