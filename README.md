This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Deploying (Cloudflare)

**https://docs.cloudposai.com** is now served by the EmDash site in `emdash/` (Worker `cloudpos-docs-cms`,
deploy with `npm run deploy` there), through the edge-caching proxy in `proxy/` (Worker `cloudpos-docs-proxy` on the
IT Consult account, `npx wrangler deploy` there). The AI help chat lives in `workers/ai`.

The Next.js site below is the earlier version; its Worker `cloudpos-docs` no longer has the custom domain.

On Windows, build with webpack in standalone mode (the default Turbopack build fails at runtime on Workers with
`ChunkLoadError`):

```bash
NEXT_PRIVATE_STANDALONE=true npx next build --webpack
npx opennextjs-cloudflare build --skipNextBuild
npx wrangler deploy
```

Keystatic editing needs the secrets `KEYSTATIC_GITHUB_CLIENT_ID`, `KEYSTATIC_GITHUB_CLIENT_SECRET` and
`KEYSTATIC_SECRET` (`npx wrangler secret put <NAME>`), and the GitHub OAuth app's callback URL must be
`https://docs.cloudposai.com/api/keystatic/github/oauth/callback`.
