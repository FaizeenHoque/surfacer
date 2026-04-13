# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.15.1 create --template minimal --types ts --add prettier eslint tailwindcss="plugins:typography,forms" --install npm ./
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Dodo Payments Credit Billing Setup

This app now supports:

- 1 credit consumed per successful AI response
- checkout-based credit purchases via Dodo Payments (including monthly plans)
- verified Dodo webhook processing for credit grants
- prevention of duplicate active subscriptions for recurring plans
- user-initiated subscription cancellation at next billing date

### Required environment variables

Set these in your server environment (`.env.local` for local dev):

```bash
# Dodo API
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_WEBHOOK_KEY=...
# optional: defaults to live_mode
DODO_PAYMENTS_ENVIRONMENT=test_mode

# Product to sell credits with
# If you only want one plan, set these:
DODO_CREDITS_PRODUCT_ID=prod_xxx
DODO_CREDITS_PACK_CREDITS=100
DODO_CREDITS_PACK_INTERVAL=month

# Compatibility aliases also accepted by the server:
# DODO_PRODUCT_ID=prod_xxx
# DODO_CREDITS_PER_PACK=100

# Optional multi-pack config (JSON string). If provided, this takes priority.
# Include price metadata so the app can show pricing before checkout.
# DODO_CREDIT_PACKS_JSON=[
#   {"id":"starter","label":"100 credits","productId":"prod_123","credits":100,"priceCents":500,"currency":"USD","interval":"month"},
#   {"id":"pro","label":"500 credits","productId":"prod_456","credits":500,"priceCents":2000,"currency":"USD","interval":"month"},
#   {"id":"max","label":"1000 credits","productId":"prod_789","credits":1000,"priceCents":3500,"currency":"USD","interval":"month"}
# ]

# Needed for webhook server-side profile updates
SUPABASE_SERVICE_ROLE_KEY=...
```

### Webhook endpoint

Configure this endpoint in Dodo Dashboard:

- `POST /api/billing/webhook`

Subscribe at least to:

- `payment.succeeded`
- `subscription.renewed`

The checkout session stores `app_user_id` and `credits_to_add` in metadata, and the webhook uses those values to grant credits.

For monthly auto top-ups, configure each mapped Dodo product as a recurring monthly billing product in Dodo.

The app also includes a "Manage subscription / cancel" action that opens Dodo customer portal.
It also supports direct in-app cancellation scheduling (cancel at next billing date).

## Dodo MCP In VS Code

Workspace MCP config is set in [.vscode/mcp.json](.vscode/mcp.json) with:

- `dodopayments` (API operations)
- `dodo-knowledge` (docs search)

After pulling changes:

1. Reload VS Code window.
2. Approve the MCP connection prompt.
3. Complete Dodo OAuth/API key flow when prompted by `mcp-remote`.
