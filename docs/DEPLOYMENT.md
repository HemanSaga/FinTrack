# Deployment

FinTrack uses a Node server with MongoDB. Express serves both `/api` and the built React frontend, giving cookies and browser requests one origin. This preserves the requested MERN architecture.

## Environment

| Variable        | Development                                             | Production                                                      |
| --------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `NODE_ENV`      | `development`                                           | `production`                                                    |
| `PORT`          | `4000`                                                  | Provided by host or `4000`                                      |
| `MONGODB_URI`   | `mongodb://127.0.0.1:27017/fintrack`                    | Required MongoDB URI, normally an Atlas SRV connection          |
| `JWT_SECRET`    | Random local file if omitted                            | Required, at least 32 characters; use a generated random secret |
| `CLIENT_ORIGIN` | `http://localhost:5173`; local loopback aliases allowed | Required exact HTTPS application origin                         |
| `ENABLE_DEMO`   | Enabled unless set to `false`                           | Disabled unless explicitly set to `true`                        |
| `TRUST_PROXY`   | `0`                                                     | Number of trusted proxy hops, often `1` on managed hosts        |

Never commit `.env`, local signing secrets or database credentials. Set secrets in your host’s environment settings. To generate a signing secret:

```sh
openssl rand -hex 32
```

## Node host

1. Provision an Atlas database (or an equivalent authenticated MongoDB deployment). Create an application database user and allow the hosting service’s outbound network access. Copy the connection URI into the host’s secret settings.
2. Use Node.js 22.12 or later.
3. Build with `npm ci && npm run build`.
4. Set the production environment variables above. Use the final HTTPS domain as `CLIENT_ORIGIN` without a trailing slash.
5. Start with `npm start`. Route HTTPS traffic to `PORT`.
6. Use `/api/health` as the readiness endpoint. Verify registration, sign-in, expense entry and report export through the final HTTPS URL.

The app enables Secure cookies in production. A plain-HTTP production URL will not retain the login cookie. Terminate TLS at the reverse proxy or host and configure its trusted hop count correctly.

## Docker Compose

Run the application and MongoDB together with health-checked orchestration:

```sh
docker compose up -d
```

Access the application at `http://localhost:4000`.

## Docker standalone

```sh
docker build -t fintrack .
docker run --env-file .env.production -p 4000:4000 fintrack
```

The image builds the frontend and backend, prunes development dependencies, runs as the unprivileged `node` user, and exposes port 4000. Provide MongoDB externally. Inside a container, `127.0.0.1` refers to that container, not the host database.

## Operational notes

- Database indexes initialize at startup. Ensure the deployment user can create the required indexes.
- The app is prepared for a single Node instance. Its rate-limit store is in process; use a shared store when scaling horizontally.
- Budget and transaction records are durable MongoDB data. Configure database backups and normal monitoring on your hosting platform.
- Demo workspaces are persistent local sample records. Keep demo mode off for a private production installation; if deliberately enabled for a public showcase, add lifecycle cleanup suitable for that environment.
- There is no external bank integration, currency conversion, email verification, or password-reset email service. None is simulated.
- Magic MCP is a development tool and is not a runtime dependency.

## Verification status

The production build and local MongoDB API have been verified. Cloud deployment and the Docker runtime require the destination infrastructure and have not been executed in this workspace.
