# Suppernote — Sprint 1 : Brief Technique Agent Code

### MVP Production-Ready — Mai 2026

---

## 🎯 Objectif du Sprint 1

Construire le **minimum viable** : un agent vocal qui répond aux appels d'un restaurant, prend une réservation simple, et envoie un rapport du soir. Durée réaliste : **4 à 6 semaines**.

> ⚠️ Toutes les estimations initiales doivent être doublées. La gestion des edge cases vocaux (bruit, accent, interruptions, silence) prend seule 2 semaines.

---

## 📁 Structure du Monorepo

```
sokar/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   └── auth.ts
│   │   │   ├── types/
│   │   │   │   └── fastify.d.ts
│   │   │   ├── modules/
│   │   │   │   ├── voice/
│   │   │   │   │   ├── pipeline.ts
│   │   │   │   │   ├── outcome.ts
│   │   │   │   │   ├── tools.ts
│   │   │   │   │   ├── prompts.ts
│   │   │   │   │   └── fillers.ts
│   │   │   │   ├── reservations/
│   │   │   │   │   ├── reservation.service.ts
│   │   │   │   │   └── reservation.schema.ts
│   │   │   │   ├── restaurants/
│   │   │   │   │   ├── restaurant.service.ts
│   │   │   │   │   └── restaurant.routes.ts
│   │   │   │   └── analytics/
│   │   │   │       └── report.service.ts
│   │   │   ├── shared/
│   │   │   │   ├── db/
│   │   │   │   │   ├── schema.prisma
│   │   │   │   │   └── client.ts
│   │   │   │   ├── queue/
│   │   │   │   │   ├── workers/
│   │   │   │   │   │   ├── evening-report.worker.ts
│   │   │   │   │   │   └── sms-confirmation.worker.ts
│   │   │   │   │   └── queues.ts
│   │   │   │   ├── redis/
│   │   │   │   │   └── client.ts
│   │   │   │   ├── email/
│   │   │   │   │   └── index.ts
│   │   │   │   ├── security/
│   │   │   │   │   ├── webhook.guard.ts
│   │   │   │   │   └── auth.guard.ts
│   │   │   │   └── logger/
│   │   │   │       └── pino.ts
│   │   │   ├── plugins/
│   │   │   │   ├── cors.ts
│   │   │   │   └── rate-limit.ts
│   │   │   └── main.ts
│   │   ├── .env.example
│   │   ├── .env.test
│   │   └── package.json
│   └── dashboard/ ...
│
├── packages/
│   ├── database/prisma/schema.prisma
│   ├── types/src/call-event.ts
│   └── config/src/constants.ts
│
├── assets/technical-issue.mp3
├── infra/
│   ├── docker-compose.yml
│   └── railway.toml
├── turbo.json
└── .env.example
```

---

## 🗄️ Schéma Base de Données (Prisma)

Fichier : `packages/database/prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  name          String?
  emailVerified Boolean   @default(false) @map("email_verified")
  image         String?
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  sessions      Session[]
  accounts      Account[]
  @@map("users")
}

model Session {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  token     String   @unique
  expiresAt DateTime @map("expires_at")
  ipAddress String?  @map("ip_address")
  userAgent String?  @map("user_agent")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("sessions")
}

model Account {
  id                    String    @id @default(uuid())
  userId                String    @map("user_id")
  accountId             String    @map("account_id")
  providerId            String    @map("provider_id")
  accessToken           String?   @map("access_token")
  refreshToken          String?   @map("refresh_token")
  accessTokenExpiresAt  DateTime? @map("access_token_expires_at")
  scope                 String?
  password              String?
  createdAt             DateTime  @default(now()) @map("created_at")
  updatedAt             DateTime  @updatedAt @map("updated_at")
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("accounts")
}

model Verification {
  id         String   @id @default(uuid())
  identifier String
  value      String
  expiresAt  DateTime @map("expires_at")
  createdAt  DateTime @default(now()) @map("created_at")
  @@map("verifications")
}

model Restaurant {
  id            String        @id @default(uuid())
  name          String
  plan          Plan          @default(STARTER)
  managerPhone  String        @map("manager_phone")
  managerEmail  String        @map("manager_email")
  phoneNumber   String        @unique @map("phone_number")
  openingHours  Json          @map("opening_hours")
  createdAt     DateTime      @default(now()) @map("created_at")
  calls         Call[]
  reservations  Reservation[]
  personality   AgentPersonality?
  callQuotas    CallQuota[]
  @@map("restaurants")
}

model Call {
  id            String       @id @default(uuid())
  restaurantId  String       @map("restaurant_id")
  callSid       String       @unique @map("call_sid")
  durationSec   Int?         @map("duration_sec")
  transcript    String?
  intent        CallIntent?
  outcome       CallOutcome?
  createdAt     DateTime     @default(now()) @map("created_at")
  restaurant    Restaurant   @relation(fields: [restaurantId], references: [id])
  reservation   Reservation?
  @@index([restaurantId, createdAt(sort: Desc)])
  @@map("calls")
}

model Reservation {
  id               String            @id @default(uuid())
  restaurantId     String            @map("restaurant_id")
  callId           String?           @unique @map("call_id")
  reservedAt       DateTime          @map("reserved_at")
  partySize        Int               @map("party_size")
  customerName     String            @map("customer_name")
  customerPhone    String?           @map("customer_phone")
  status           ReservationStatus @default(CONFIRMED)
  estimatedRevenue Decimal?          @map("estimated_revenue") @db.Decimal(10, 2)
  createdAt        DateTime          @default(now()) @map("created_at")
  restaurant       Restaurant        @relation(fields: [restaurantId], references: [id])
  call             Call?             @relation(fields: [callId], references: [id])
  @@index([restaurantId, createdAt(sort: Desc)])
  @@map("reservations")
}

model AgentPersonality {
  id                String      @id @default(uuid())
  restaurantId      String      @unique @map("restaurant_id")
  profileType       ProfileType @default(BISTROT_BRASSERIE) @map("profile_type")
  speakingRate      Decimal     @default(1.0) @map("speaking_rate") @db.Decimal(3, 2)
  fillerStyle       FillerStyle @default(CASUAL) @map("filler_style")
  systemPromptExtra String?     @map("system_prompt_extra")
  voiceIdEl         String?     @map("voice_id_el")
  updatedAt         DateTime    @updatedAt @map("updated_at")
  restaurant        Restaurant  @relation(fields: [restaurantId], references: [id])
  @@map("agent_personalities")
}

model CallQuota {
  restaurantId  String     @map("restaurant_id")
  monthKey      String     @map("month_key")
  callCount     Int        @default(0) @map("call_count")
  restaurant    Restaurant @relation(fields: [restaurantId], references: [id])
  @@id([restaurantId, monthKey])
  @@map("call_quotas")
}

enum Plan              { STARTER PRO PREMIUM }
enum CallIntent        { RESERVATION HOURS MENU CANCEL OTHER }
enum CallOutcome       { RESERVED INFO NO_ACTION HANDOFF ERROR }
enum ReservationStatus { CONFIRMED CANCELLED NO_SHOW SEATED }
enum ProfileType       { BISTROT_BRASSERIE GASTRONOMIQUE SEMI_GASTRO }
enum FillerStyle       { CASUAL FORMAL WARM }
```

---

## 🔌 Variables d'Environnement

### `.env.example`

```env
DATABASE_URL="postgresql://callyx:password@localhost:5432/callyx_dev"
REDIS_URL="redis://localhost:6379"
VAPI_API_KEY="sk_vapi_..."
VAPI_WEBHOOK_SECRET="whsec_..."
VAPI_ASSISTANT_ID="asst_..."
OPENROUTER_API_KEY="sk-or-..."
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
ELEVENLABS_API_KEY="sk_el_..."
SMTP_HOST="smtp.resend.com"
SMTP_PORT="465"
SMTP_USER="resend"
SMTP_PASS="re_..."
EMAIL_FROM="noreply@sokar.fr"
PUBLIC_URL="https://api.sokar.fr"
NODE_ENV="development"
LOG_LEVEL="info"
TZ="Europe/Paris"
BETTER_AUTH_SECRET="..."
BETTER_AUTH_URL="https://app.sokar.fr"
```

### `.env.test`

```env
DATABASE_URL="postgresql://callyx:password@localhost:5432/sokar_test"
REDIS_URL="redis://localhost:6379"
VAPI_WEBHOOK_SECRET="test-secret"
BETTER_AUTH_SECRET="test-auth-secret"
BETTER_AUTH_URL="http://localhost:3000"
TZ="Europe/Paris"
NODE_ENV="test"
```

---

## 🌐 Routes API — Sprint 1

### Webhooks Vapi

```
POST /voice/incoming
POST /voice/end
POST /voice/function-call
```

### API REST Dashboard — authGuard sur toutes ces routes

```
POST   /restaurants
GET    /restaurants/:id
PATCH  /restaurants/:id

GET    /calls?restaurantId=&limit=&offset=
GET    /calls/:id

GET    /reservations?restaurantId=&date=
POST   /reservations
PATCH  /reservations/:id
DELETE /reservations/:id

GET    /analytics/overview?restaurantId=&period=

GET    /health
POST   /auth/*
```

---

## 📦 `packages/config/src/constants.ts`

```typescript
export const PLANS = {
  STARTER: { label: 'Starter' },
  PRO: { label: 'Pro' },
  PREMIUM: { label: 'Premium' },
} as const;

export const INTERNAL_CALL_ALERT_THRESHOLD = 3000;
export const CIRCUIT_BREAKER_HOURLY_LIMIT = 200;
export const REDIS_CTX_TTL_SECONDS = 300;
export const SMS_RATE_LIMIT_SECONDS = 900;

export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
```

---

## 🔤 Types Internes

```typescript
// packages/types/src/call-event.ts

export interface CallEvent {
  id: string;
  phoneNumberId: string;
  endedReason?: 'transfer' | 'error' | 'customer-ended-call' | 'assistant-ended-call' | string;
  transcript?: string;
  startedAt?: string;
  endedAt?: string;
}
```

---

## 🔧 Augmentation Fastify — `src/types/fastify.d.ts`

```typescript
import type { db } from '../shared/db/client';
import type { queues } from '../shared/queue/queues';

declare module 'fastify' {
  interface FastifyInstance {
    db: typeof db;
    queues: typeof queues;
  }
}
```

---

## 🔐 Better Auth — `lib/auth.ts`

```typescript
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { db } from '../shared/db/client';

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env.NODE_ENV === 'production',
  },
});
```

---

## 📧 Email — `shared/email/index.ts`

```typescript
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST!,
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: true,
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM ?? 'noreply@sokar.fr',
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}
```

---

## 🎯 Outcome Detection — `voice/outcome.ts`

```typescript
import type { CallEvent } from '@suppernote/types';

export type CallOutcome = 'RESERVED' | 'INFO' | 'NO_ACTION' | 'HANDOFF' | 'ERROR';

export function detectOutcome(call: Pick<CallEvent, 'transcript' | 'endedReason'>): CallOutcome {
  if (call.transcript?.match(/réservation confirmée|numéro de réservation/i)) return 'RESERVED';
  if (call.endedReason === 'transfer') return 'HANDOFF';
  if (call.endedReason === 'error') return 'ERROR';
  if (call.transcript?.match(/horaire|ouvert|fermé/i)) return 'INFO';
  return 'NO_ACTION';
}
```

---

## 🛠️ Tools Vapi — `voice/tools.ts`

```typescript
const TIME_PATTERN = [
  '^(',
  ' [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/57331281/b661ecad-c5ae-4d03-8749-dfc7e5170650/paste.txt)\\d',
  '|2[0-3]):[0-5]\\d$',
].join('');

export function getRestaurantTools(_restaurantId: string) {
  return [
    {
      type: 'function',
      function: {
        name: 'createReservation',
        description:
          'Crée une réservation. À appeler uniquement après avoir confirmé date, heure, nombre de personnes et nom du client.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date', description: 'Date au format YYYY-MM-DD' },
            time: {
              type: 'string',
              pattern: TIME_PATTERN,
              description: 'Heure au format HH:MM (ex: 19:30)',
            },
            partySize: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: 'Nombre de personnes — ≥8 déclenche handoffToManager',
            },
            customerName: { type: 'string', description: 'Nom complet du client' },
            customerPhone: { type: 'string', description: 'Téléphone du client (optionnel)' },
          },
          required: ['date', 'time', 'partySize', 'customerName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'checkAvailability',
        description: 'Vérifie si le restaurant est ouvert pour un créneau donné.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date' },
            time: { type: 'string', pattern: TIME_PATTERN },
            partySize: { type: 'integer', minimum: 1 },
          },
          required: ['date', 'time', 'partySize'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getOpeningHours',
        description: "Retourne les horaires d'ouverture formatés pour être lus à voix haute.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'handoffToManager',
        description:
          "Transfère l'appel au gérant. Utiliser si : groupe ≥8 personnes, demande complexe, client mécontent, ou incompréhension après 2 essais.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}
```

---

## 🎙️ Prompts — `voice/prompts.ts`

```typescript
type DaySlot = { open: string; close: string } | null;
export type OpeningHours = {
  mon?: DaySlot;
  tue?: DaySlot;
  wed?: DaySlot;
  thu?: DaySlot;
  fri?: DaySlot;
  sat?: DaySlot;
  sun?: DaySlot;
};

const DAY_LABELS: Record<string, string> = {
  mon: 'Lundi',
  tue: 'Mardi',
  wed: 'Mercredi',
  thu: 'Jeudi',
  fri: 'Vendredi',
  sat: 'Samedi',
  sun: 'Dimanche',
};

export function formatOpeningHours(hours: OpeningHours): string {
  return Object.entries(hours)
    .map(([day, slot]) =>
      slot
        ? `${DAY_LABELS[day] ?? day} : ${slot.open}–${slot.close}`
        : `${DAY_LABELS[day] ?? day} : fermé`,
    )
    .join('\n');
}

export function buildSystemPrompt(ctx: any): string {
  return `Tu es l'assistant vocal de ${ctx.name}.

RÈGLE ABSOLUE : Au tout début de chaque appel, tu DOIS dire :
"Bonjour, ${ctx.name}, cet appel peut être enregistré à des fins de qualité de service."

Ensuite seulement, tu demandes en quoi tu peux aider.

COMPORTEMENT :
- Tu réponds uniquement en français
- Tu es concis : 1-2 phrases maximum par réponse
- Tu ne peux PAS improviser des informations (prix, menu) — tu dis "je vous transfère"
- Pour toute réservation groupe de 8+ personnes → transfert immédiat au gérant
- Si tu ne comprends pas après 2 essais → transfert au gérant

HORAIRES :
${formatOpeningHours(ctx.openingHours)}

OUTILS DISPONIBLES :
- checkAvailability : vérifier si un créneau est disponible
- createReservation : confirmer une réservation (toujours après checkAvailability)
- getOpeningHours : donner les horaires précis
- handoffToManager : transférer l'appel au gérant

${ctx.personality?.systemPromptExtra ?? ''}`;
}
```

---

## 🛡️ Sécurité

### `shared/security/webhook.guard.ts`

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

export async function vapiWebhookGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = req.headers['x-vapi-secret'] as string | undefined;
  if (!secret || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    req.log.warn({ ip: req.ip }, 'Invalid or missing Vapi webhook secret');
    reply.status(403).send({ error: 'Forbidden' });
    return;
  }
}
```

### `shared/security/auth.guard.ts`

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';
import { auth } from '../../lib/auth';

export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: req.headers as any });
  if (!session?.user) {
    reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  (req as any).user = session.user;
}
```

---

## 📦 Reservation Service — `reservations/reservation.service.ts`

```typescript
import { db } from '../../shared/db/client';

export interface CreateReservationInput {
  restaurantId: string;
  callId?: string;
  reservedAt: Date;
  partySize: number;
  customerName: string;
  customerPhone?: string;
}

export class ReservationService {
  static async create(input: CreateReservationInput) {
    return db.reservation.create({
      data: {
        restaurantId: input.restaurantId,
        callId: input.callId,
        reservedAt: input.reservedAt,
        partySize: input.partySize,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        status: 'CONFIRMED',
        estimatedRevenue: input.partySize * 35,
      },
    });
  }

  static async findByRestaurant(restaurantId: string, date?: string) {
    const where: any = { restaurantId };
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      where.reservedAt = { gte: start, lte: end };
    }
    return db.reservation.findMany({ where, orderBy: { reservedAt: 'asc' } });
  }
}
```

---

## 🏪 Restaurant Service — `restaurants/restaurant.service.ts`

```typescript
import { db } from '../../shared/db/client';
import { getCachedContext, setCachedContext, redisCache } from '../../shared/redis/client';
import * as Sentry from '@sentry/node';
import {
  INTERNAL_CALL_ALERT_THRESHOLD,
  CIRCUIT_BREAKER_HOURLY_LIMIT,
  REDIS_CTX_TTL_SECONDS,
} from '@suppernote/config';

function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getHourKey() {
  const d = new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]
    .map((n) => String(n).padStart(2, '0'))
    .join('-');
}

export class RestaurantService {
  static async loadContext(phoneNumberId: string) {
    const cacheKey = `phone:${phoneNumberId}`;
    const cached = await getCachedContext(cacheKey);
    if (cached) return cached;
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { phoneNumber: phoneNumberId },
      include: { personality: true },
    });
    await setCachedContext(cacheKey, restaurant, REDIS_CTX_TTL_SECONDS);
    return restaurant;
  }

  static async checkMarginHealth(restaurantId: string): Promise<boolean> {
    const monthKey = getCurrentMonthKey();
    const countKey = `infra:calls:${restaurantId}:${monthKey}`;
    const count = await redisCache.incr(countKey);
    if (count === 1) await redisCache.expire(countKey, 33 * 24 * 3600);

    if (count > INTERNAL_CALL_ALERT_THRESHOLD) {
      Sentry.captureMessage(`[MARGIN] Restaurant ${restaurantId} atteint ${count} appels ce mois`, {
        level: 'warning',
        tags: { restaurantId, monthKey },
      });
    }

    const hourKey = `infra:calls:${restaurantId}:${getHourKey()}`;
    const hourCount = await redisCache.incr(hourKey);
    if (hourCount === 1) await redisCache.expire(hourKey, 3600);

    if (hourCount > CIRCUIT_BREAKER_HOURLY_LIMIT) {
      Sentry.captureMessage(
        `[CIRCUIT_BREAKER] Restaurant ${restaurantId}: ${hourCount} appels en 1h`,
        {
          level: 'error',
        },
      );
      return false;
    }
    return true;
  }

  static isOpen(ctx: any, date: string, time: string): boolean {
    const dayMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const d = new Date(`${date}T${time}`);
    const slot = (ctx.openingHours as any)[dayMap[d.getDay()]];
    if (!slot) return false;
    const [oh, om] = slot.open.split(':').map(Number);
    const [ch, cm] = slot.close.split(':').map(Number);
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins >= oh * 60 + om && mins < ch * 60 + cm;
  }
}
```

---

## 🍽️ Restaurant Routes — `restaurants/restaurant.routes.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { redisCache } from '../../shared/redis/client';
import { authGuard } from '../../shared/security/auth.guard';

const CreateRestaurantSchema = z.object({
  name: z.string().min(2).max(100),
  managerPhone: z.string().regex(/^\+?[0-9]{10,15}$/),
  managerEmail: z.string().email(),
  phoneNumber: z.string().min(5),
  openingHours: z.record(
    z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    z.union([z.object({ open: z.string(), close: z.string() }), z.null()]),
  ),
  plan: z.enum(['STARTER', 'PRO', 'PREMIUM']).default('STARTER'),
});

export async function restaurantRoutes(app: FastifyInstance) {
  app.post('/restaurants', { preHandler: authGuard }, async (req, reply) => {
    const body = CreateRestaurantSchema.parse(req.body);
    try {
      const restaurant = await db.restaurant.create({ data: body });
      await app.queues.eveningReport.upsertJobScheduler(
        `nightly-${restaurant.id}`,
        { pattern: '0 23 * * *', tz: 'Europe/Paris' },
        { name: 'nightly', data: { restaurantId: restaurant.id } },
      );
      return reply.status(201).send(restaurant);
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: 'Phone number already registered' });
      }
      throw err;
    }
  });

  app.get('/restaurants/:id', { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(
      await db.restaurant.findUniqueOrThrow({ where: { id }, include: { personality: true } }),
    );
  });

  app.patch('/restaurants/:id', { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateRestaurantSchema.partial().parse(req.body);
    const updated = await db.restaurant.update({ where: { id }, data: body });
    await redisCache.del(`phone:${updated.phoneNumber}`);
    return reply.send(updated);
  });
}
```

---

## 🗃️ Redis — `shared/redis/client.ts`

```typescript
import Redis from 'ioredis';

const baseUrl = process.env.REDIS_URL!;

export const redisSession = new Redis(baseUrl + '/0');
export const redisCache = new Redis(baseUrl + '/1');
export const redisQueue = new Redis(baseUrl + '/2');

export async function getCachedContext(key: string) {
  const cached = await redisCache.get(key);
  return cached ? JSON.parse(cached) : null;
}

export async function setCachedContext(key: string, ctx: object, ttl = 300) {
  await redisCache.set(key, JSON.stringify(ctx), 'EX', ttl);
}
```

---

## 📬 Queue BullMQ — `shared/queue/queues.ts`

```typescript
import { Queue } from 'bullmq';
import { redisQueue } from '../redis/client';

export const queues = {
  eveningReport: new Queue('evening-report', { connection: redisQueue }),
  sms: new Queue('sms-notification', {
    connection: redisQueue,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
  }),
};
```

---

## 👷 Worker Evening Report — `queue/workers/evening-report.worker.ts`

```typescript
import { Worker } from 'bullmq';
import { redisQueue } from '../redis/client';
import { db } from '../db/client';
import { sendEmail } from '../email';
import { buildReportEmail } from '../../modules/analytics/report.service';

export const eveningReportWorker = new Worker(
  'evening-report',
  async (job) => {
    const { restaurantId } = job.data;

    const startDay = new Date();
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date();
    endDay.setHours(23, 59, 59, 999);

    const [calls, reservations, restaurant] = await Promise.all([
      db.call.findMany({ where: { restaurantId, createdAt: { gte: startDay, lte: endDay } } }),
      db.reservation.findMany({
        where: { restaurantId, createdAt: { gte: startDay, lte: endDay } },
      }),
      db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
    ]);

    const reserved = reservations.filter((r) => r.status === 'CONFIRMED').length;
    const cancelled = reservations.filter((r) => r.status === 'CANCELLED').length;
    const estimatedRevenue = reservations
      .filter((r) => r.estimatedRevenue)
      .reduce((sum, r) => sum + Number(r.estimatedRevenue), 0);

    await sendEmail({
      to: restaurant.managerEmail,
      subject: `📊 Résumé Sokar — ${new Date().toLocaleDateString('fr-FR')}`,
      html: buildReportEmail({
        restaurantName: restaurant.name,
        totalCalls: calls.length,
        reserved,
        cancelled,
        estimatedRevenue,
      }),
    });
  },
  { connection: redisQueue },
);
```

---

## 🔀 Pipeline Vocal — `voice/pipeline.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { vapiWebhookGuard } from '../../shared/security/webhook.guard';
import { ReservationService } from '../reservations/reservation.service';
import { RestaurantService } from '../restaurants/restaurant.service';
import { buildSystemPrompt, formatOpeningHours } from './prompts';
import { getRestaurantTools } from './tools';
import { detectOutcome } from './outcome';
import { DEFAULT_VOICE_ID } from '@suppernote/config';

interface VapiIncomingPayload {
  call: { id: string; phoneNumberId: string };
}
interface VapiFunctionCallPayload {
  functionCall: { name: string; parameters: Record<string, any> };
  call: { id: string; phoneNumberId: string };
}
interface VapiEndPayload {
  call: {
    id: string;
    endedReason?: string;
    transcript?: string;
    startedAt?: string;
    endedAt?: string;
  };
}

export async function voiceRoutes(app: FastifyInstance) {
  app.post('/voice/incoming', { preHandler: vapiWebhookGuard }, async (req, reply) => {
    const body = req.body as VapiIncomingPayload;
    const ctx = await RestaurantService.loadContext(body.call.phoneNumberId);

    const safe = await RestaurantService.checkMarginHealth(ctx.id);
    if (!safe) {
      return reply
        .type('text/xml')
        .send(
          `<Response><Play>https://cdn.sokar.fr/assets/technical-issue.mp3</Play><Hangup/></Response>`,
        );
    }

    return reply.send({
      assistant: {
        firstMessage: `Bonjour, ${ctx.name}, cet appel peut être enregistré à des fins de qualité de service. En quoi puis-je vous aider ?`,
        model: {
          messages: [{ role: 'system', content: buildSystemPrompt(ctx) }],
        },
        voice: {
          provider: 'elevenlabs',
          voiceId: ctx.personality?.voiceIdEl ?? DEFAULT_VOICE_ID,
        },
        tools: getRestaurantTools(ctx.id),
      },
    });
  });

  app.post('/voice/function-call', { preHandler: vapiWebhookGuard }, async (req, reply) => {
    const { functionCall, call } = req.body as VapiFunctionCallPayload;
    const ctx = await RestaurantService.loadContext(call.phoneNumberId);

    switch (functionCall.name) {
      case 'createReservation': {
        const { date, time, partySize, customerName, customerPhone } = functionCall.parameters;
        const reservation = await ReservationService.create({
          restaurantId: ctx.id,
          callId: call.id,
          reservedAt: new Date(`${date}T${time}`),
          partySize,
          customerName,
          customerPhone,
        });
        return reply.send({
          result: `Réservation confirmée pour ${customerName}, le ${date} à ${time}, pour ${partySize} personnes. Numéro de réservation : ${reservation.id.slice(0, 8).toUpperCase()}.`,
        });
      }

      case 'checkAvailability': {
        const { date, time, partySize } = functionCall.parameters;
        const available = RestaurantService.isOpen(ctx, date, time);
        return reply.send({
          result: available
            ? `Oui, nous avons de la disponibilité le ${date} à ${time} pour ${partySize} personnes.`
            : `Désolé, nous sommes fermés ce créneau. ${formatOpeningHours(ctx.openingHours)}`,
        });
      }

      case 'getOpeningHours':
        return reply.send({ result: formatOpeningHours(ctx.openingHours) });

      case 'handoffToManager':
        app.log.info({ restaurantId: ctx.id, callId: call.id }, 'Handoff to manager');
        await app.queues.sms.add('manager-alert', {
          restaurantId: ctx.id,
          message: '📞 Un client demande à vous parler — appel en cours',
        });
        return reply.send({
          result: 'Je vous transfère immédiatement.',
          phoneNumber: ctx.managerPhone,
        });

      default:
        return reply.status(400).send({ error: `Unknown function: ${functionCall.name}` });
    }
  });

  app.post('/voice/end', { preHandler: vapiWebhookGuard }, async (req, reply) => {
    const { call } = req.body as VapiEndPayload;
    await app.db.call.update({
      where: { callSid: call.id },
      data: {
        durationSec: Math.round(
          call.endedAt && call.startedAt
            ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
            : 0,
        ),
        transcript: call.transcript ?? null,
        outcome: detectOutcome(call),
      },
    });
    return reply.send({ received: true });
  });
}
```

---

## ⏰ Main — `main.ts`

```typescript
import Fastify from 'fastify';
import { db } from './shared/db/client';
import { redisCache } from './shared/redis/client';
import { queues } from './shared/queue/queues';
import { voiceRoutes } from './modules/voice/pipeline';
import { restaurantRoutes } from './modules/restaurants/restaurant.routes';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth';
import './shared/queue/workers/evening-report.worker';

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.decorate('db', db);
  app.decorate('queues', queues);

  await app.register(voiceRoutes);
  await app.register(restaurantRoutes);

  await app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    });
    instance.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/auth/*',
      handler: async (req, reply) => {
        const handler = toNodeHandler(auth);
        await handler(req.raw, reply.raw);
        reply.hijack();
      },
    });
  });

  app.get('/health', async (_req, reply) => {
    let dbStatus = 'ok',
      redisStatus = 'ok';
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }
    try {
      await redisCache.ping();
    } catch {
      redisStatus = 'error';
    }
    return reply.send({
      status: dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded',
      db: dbStatus,
      redis: redisStatus,
      vapi: 'not_checked',
    });
  });

  return app;
}

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down gracefully...');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});

setImmediate(async () => {
  try {
    const restaurants = await db.restaurant.findMany({ select: { id: true } });
    for (const r of restaurants) {
      await queues.eveningReport.upsertJobScheduler(
        `nightly-${r.id}`,
        { pattern: '0 23 * * *', tz: 'Europe/Paris' },
        { name: 'nightly', data: { restaurantId: r.id } },
      );
    }
  } catch (err) {
    app.log.error(err, 'Failed to register schedulers on startup');
  }
});
```
