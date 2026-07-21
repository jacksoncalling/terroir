# Terroir Pilot Onboarding

How to set up a new pilot user from scratch. Run through this once per person.

---

## Step 1 — Create their project

Open the Terroir web app, create a new project for them, and pick the right hub preset.
Copy the project UUID from the URL — you need it in the next step.

---

## Step 2 — Mint their token

Run this from `terroir/` (where `.env.local` lives):

```bash
npx ts-node --skip-project scripts/mint-token.ts \
  --name "Firstname pilot" \
  --scopes read,write,synthesis \
  --project <project-uuid-from-step-1>
```

The script prints the plaintext token once. Copy it immediately — it is not stored anywhere.

### Verify the token is scoped to their project (before sending)

The `--project` flag above is the only thing limiting a pilot user to their own project, and there is no second safety net. Confirm it took: using **their** token, list projects and check that exactly one comes back.

```bash
curl -s -H "Authorization: Bearer <their-token>" \
  https://terroir-mu.vercel.app/api/v1/projects
```

Expected: only their project. If more than one comes back, the token was minted without `--project` and can read and write every project in Terroir. Revoke it (see below) and re-mint with the `--project` flag.

To revoke a token later, run this in the Supabase SQL editor:

```sql
UPDATE api_tokens SET revoked_at = now() WHERE name = 'Firstname pilot';
```

---

## Step 3 — Build the remote MCP (once, not per user)

The remote MCP binary only needs to be built once and then shared or bundled:

```bash
cd mcp-server
npm install
npm run build:remote
# output: dist/remote.js
```

Send the user the `mcp-server/` folder (or just `dist/remote.js` + the `grammar/` and `icm/` folders).
The `icm/` folder is the orientation layer: the remote client exposes it over MCP as
`terroir://icm/*` resources, and the init instructions point the user's agent at
`terroir://icm/start-here`, so it can explain Terroir and run a good first session.

---

## Step 4 — What to send the pilot user

Send them these three things:

**Their token** (from step 2 — the long hex string)

**Their project ID** (the UUID from step 1)

**Setup instructions** (copy-paste this to them):

---

> **Setting up your Terroir MCP**
>
> 1. Set your token as an environment variable. Add this to your shell profile
>    (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`):
>
>    ```bash
>    export TERROIR_API_TOKEN=<your-token>
>    ```
>
>    Then reload: `source ~/.zshrc` (or open a new terminal).
>
> 2. Register the MCP with Claude Code:
>
>    ```bash
>    claude mcp add terroir node /absolute/path/to/mcp-server/dist/remote.js
>    ```
>
>    Replace the path with wherever you put the `dist/remote.js` file.
>
> 3. Start a new Claude Code session. You should see `terroir` in the MCP list.
>
> 4. Tell your agent your project ID: `<project-uuid>`
>
> 5. Try it:
>    - "List my Terroir projects"
>    - "Add this document as a source: [paste your text]"
>    - "Surface the tensions in my project"
>    - "Read the evaluative field"

---

## Limits

Each token allows 200 API calls per day. The window resets 24 hours after the first call.
If they hit the limit, they get a `429` response with a `reset_at` timestamp telling them
when it clears.

If a legitimate user needs more capacity, update the cap in `src/lib/api-auth.ts`
(the `DAILY_CAP` constant) and redeploy, or mint them a second token for a second project.
