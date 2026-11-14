# MYUKCHEF API

The API, database and scheduled jobs behind MYUKCHEF: the website ([myukchef_frontend](https://github.com/omoyeye/myukchef_frontend)) and the iOS and Android app both use it.

Built with Express 5, TypeScript, MySQL and Drizzle ORM.

## Getting started

You need Node.js 20 or later and a MySQL 8 database.

```sh
npm install
cp .env.example .env      # fill in DATABASE_URL and AUTH_SECRET at least
npm run db:push           # create or update the tables
npm run db:seed           # create the Super Admin account (add -- --demo for sample dishes)
npm run dev
```

The API listens on the `PORT` in `.env` (3002 in the example) under `/api`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the API and restart it when files change |
| `npm run build` / `npm start` | Build to `dist/index.js` and run it |
| `npm run typecheck` | Check the types |
| `npm run db:push` | Bring the database up to date with `src/db/schema.ts` |
| `npm run db:seed` | Create the Super Admin account |
| `npm run push:keys` | Make the keys for website push notifications |
| `npm test` | Unit tests (no database needed) |
| `npm run test:integration` | The full test suite against a throwaway database: set `TEST_DATABASE_URL` to a database whose name contains "test" (it is wiped each run) |
| `npm run backup` | Back up the database and uploads (see DIRECTADMIN_DEPLOYMENT.md for the nightly job) |

Every push to GitHub runs the types, both test suites and a build (see `.github/workflows/ci.yml`). A red cross on a commit means something broke.

## Payments and email

Card payments use **Stripe** and all email and text messages use **Brevo**. The Super Admin enters the keys in the website under **Super Admin → Payments & email** (or in the app under **Payments and email**). They are stored encrypted with `AUTH_SECRET` (or `SECRETS_KEY`), and secret keys are only ever shown masked. Any field left empty there falls back to the matching variable in `.env`.

- **No Stripe key:** orders are placed without payment, as before.
- **Stripe set up and switched on:** the customer pays on Stripe's page first. Chefs, admins and the customer only hear about the order once it's paid. Unpaid orders are released after an hour. Cancelling a paid order refunds it in full.
- **Stripe webhook:** in the Stripe dashboard, add the webhook address shown on the Payments & email page (`https://<your API>/api/payments/stripe/webhook`) with the events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, then save its signing secret. Payments are also confirmed when the customer returns from Stripe, so a missed webhook doesn't lose an order.

Start with Stripe **test** keys and the test card 4242 4242 4242 4242, then swap in live keys.

## Hosting

The simplest setup is one domain: build the website and let this API serve it (`FRONTEND_DIST`, by default `../myukchef_frontend/dist`). Uploaded photos and videos are served from `/uploads` and the website links to them by that path, so the website and the API should share a domain. If the website is hosted separately, have that host pass `/api` and `/uploads` through to this API. Otherwise set `CORS_ORIGINS` here and `VITE_API_URL` on the website, and note that uploaded images won't load until they are served from the website's domain.

Keep `uploads/` in your backups: it holds every photo and kitchen video.

## License

All rights reserved.
