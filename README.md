# FinTrack

**Your expenses. Your buckets. Your control.**

A personal expense notebook built with React, Vite, TypeScript, Express and MongoDB. The warm light interface includes an original WebGL budget sculpture, interactive dimensional cards, live spending charts, month-specific budgets, account authentication and private workspaces.

## Run locally

### Quick start with Docker Compose

Run the application and MongoDB with a single command:

```sh
docker compose up
```

Open **http://localhost:4000**.

### Or run with local Node.js and MongoDB

Requirements: Node.js 22.12+ and a running MongoDB instance on port 27017 (or a configured `MONGODB_URI`).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on **http://localhost:4000**.

You can register a real local account or choose **Explore the demo**. Each demo creates a separate MongoDB-backed workspace with clearly labeled sample expenses and six months of history. Registered accounts start empty with eleven default buckets. All statistics, including demo statistics, are calculated by the API from database records.

Default local database: `mongodb://127.0.0.1:27017/fintrack`. To change it, copy `.env.example` to `.env` and edit `MONGODB_URI`. A random local signing secret is generated in ignored `.local/jwt-secret` if none is supplied. No account credentials or API keys are committed.

## What works

- Registration, login, logout, profile and currency/timezone preferences, password changes.
- HttpOnly JWT sessions; password changes and logout invalidate older sessions.
- Expense creation, editing, moving between buckets, deletion with confirmation, and duplicate-submit protection.
- Eleven default buckets; custom buckets with icon/color selection; archiving and restoration.
- Separate monthly budgets that preserve historical amounts, with an all-bucket planner and a reviewable copy of the previous month's plan.
- Live summary cards, spending distribution, daily and six-month trends, budget comparisons, derived budget warnings and daily spending insights.
- Transaction search across descriptions and notes, bucket/month/date-range filters, sorting, filtered totals, and pagination.
- Monthly reports and transaction exports with CSV downloads containing actual records; annual report API.
- Responsive layouts, mobile navigation, keyboard search (`⌘/Ctrl K`), new-expense shortcut (`N`), focus-managed dialogs and reduced-motion support.
- Three.js sculpture loaded on demand, with a static fallback on devices without WebGL; pointer-driven tilt and glow cards that respect reduced motion.

Currency is a **display denomination**, not foreign-exchange conversion. Changing it does not convert existing values. Timezone changes regroup UTC transaction timestamps into the newly selected local calendar.

## Commands

```sh
npm run dev          # Frontend + backend, with hot reload
npm run typecheck    # Strict TypeScript checks in both workspaces
npm test             # MongoDB-backed business and API regression suite
npm run build        # Frontend assets + compiled backend
npm start            # Express serves API and built frontend on port 4000
npm run format       # Format source and documentation
```

Tests use a new `fintrack_test_<random-id>` database on local MongoDB for every run. Only that database is removed afterwards; application data is not touched.

## Project map

```text
frontend/src/
  components/       Shared controls, forms, charts, shell and 3D scene
  pages/            Authentication, dashboard, expenses, buckets, reports, settings
  lib/              API hooks, types, account/month state and formatting
backend/src/
  config/           Environment and database connection
  models/           User, Bucket, BucketBudget and Transaction schemas
  controllers/      HTTP input parsing and service orchestration
  services/         Business rules, ownership, aggregation and demo setup
  routes/           REST routes and rate limits
  middleware/       Session authentication, origin protection and errors
  utils/            Calendar and monetary calculations
backend/tests/      Critical API and business-rule tests
design-system/      Visual decisions and UI/UX skill usage
docs/               Architecture, API, database, testing and deployment notes
```

## Design tools

UI/UX Pro Max informed the design system, dimensional layering, React patterns, accessibility and reduced-motion behavior. **21st.dev Magic MCP was successfully used** to discover and retrieve ThemeOcean's 3D Animated Tilt & Dynamic Glow Card. Its interaction pattern is adapted into the dashboard's reusable `MagicTiltCard`, connected to real budget data. See [Design sources](docs/DESIGN_SOURCES.md) for attribution and implementation details.

Graphify was used to inspect structural relationships before extending the application. Neither Graphify nor a Magic key is needed to run FinTrack.

## Production

See [Deployment](docs/DEPLOYMENT.md) for Node hosting, MongoDB Atlas, environment variables and the same-origin cookie setup. A Dockerfile is included. The application has been built and tested locally; it has not been deployed to a cloud account.

Further documentation: [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [Database](docs/DATABASE.md), [Verification](docs/TESTING.md), [Design system](design-system/fintrack/MASTER.md). GitHub Actions runs type checks, all 32 MongoDB integration tests and the production build on pushes and pull requests.

## Preview

![FinTrack dashboard with sample data](docs/screenshots/dashboard-desktop.jpg)

[Mobile dashboard](docs/screenshots/dashboard-mobile.jpg) · [Monthly budget planner](docs/screenshots/budget-planner.jpg) · [Mobile expense entry](docs/screenshots/expense-mobile.jpg)
