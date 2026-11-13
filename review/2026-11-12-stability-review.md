# tg-reader stability review

Date: 2026-11-12
Reviewed commit: 67a2332775455c3cf61282ab8210a98f301d5f27 (chore: add gitleaks secret scanning), branch main, clean working tree

## Scope

This review covered the whole repository at commit 67a2332775. Five area reviews ran in parallel: worker (the Cloudflare Worker API, cron jobs and auth), listener (the GramJS Telegram client, ingest buffer and gap recovery), dashboard+CLI (frontend screens and cli/tg.ts), data+infra (schema, setup script, deploy docs and CI workflows), and security (auth boundaries, tool scoping, secrets). Every medium and high finding was then independently re-verified against the source in a separate fact-checking pass, which reproduced the cited lines, corrected small line-number slips, and ran everything that could run locally: the worker type-check, the frontend and CLI builds, a clean `npx tsc --noEmit` inside gramjs/, targeted greps, Node probes against installed dependencies, the GramJS flood-error mapper, and a /tmp probe of Node module resolution for the setup script. The five areas produced 55 raw findings; 3 were rejected on fact-check and are listed under "Checked and rejected"; duplicates between areas were merged, keeping the stronger evidence, leaving the 44 findings below. Nothing was executed against the live Cloudflare Worker, the Fly machines, Neon, R2, or Telegram, and the repo contains no tests to run.

## Executive summary

The system is in good shape for the owner's daily use but it fails quietly, and it is not yet installable by anyone else, which is the stated goal of issue #83.

What the reviewers found, in plain terms: the parts that were designed carefully (pagination, token handling, the outbox claim, gap recovery) are genuinely solid, and no SQL injection or unauthenticated route was found anywhere. The problems are concentrated in failure handling. Four things can go wrong today without any error surfacing: the intake API rejects some perfectly valid batches (this is open issue #87, confirmed and generalized), a dropped Telegram connection can permanently punch a hole in the archive, an interrupted or killed listener silently loses whatever it had buffered, and automated sends can deliver the same message to the same person twice. On top of that, the self-hosting path added for issue #83 fails at several steps, the dashboard cannot be served by any deploy of this tree even though the docs say it can, and CI deploys to production without running a single check while the project's own type-check is red on main right now.

Fix these first:

1. **The two ingest bugs from issue #87.** Make /contacts default `is_mutual`/`is_bot` to 0 instead of NULL, and dedupe each batch by its conflict key before the insert (H1, H2). Why first: a contract-valid request deterministically fails with a 500, and the listener then retries the same rejected batch forever, blocking every newer message and losing the buffer on the next restart.
2. **The listener's silent message-loss paths.** Recover gaps on reconnect instead of only at startup, stop persisting pts past undelivered messages, keep the buffer on disk and flush it on every exit, cap it with a dead-letter for rejected batches, and write state.json atomically (H3-H6). Why: these lose archive data permanently, with no error anywhere.
3. **Duplicate sends.** Track sent message ids so the 5-minute stuck reset cannot re-send, add a re-entrancy guard to outbox polling, and turn pending-action fetching into a claim (H7-H9). Why: this sends duplicate Telegram messages from the owner's account to real people.
4. **Make the shipped self-host path actually finish.** Add `[assets]` to wrangler.toml plus a frontend build in CI (H14), fix setup phases C and G (H11, H12), create the R2 bucket the config requires (M8), and rewrite DEPLOY.md (H13). Why: every one of these blocks a fresh installer today, and two of them fail after printing success.
5. **Make CI check something.** Fix the one-line type error and gate deploys on type-check and build (M5); while in there, close the three unscoped MCP tools (M12, M13). Why: right now nothing stands between main and production, and a scoped agent token can read the full address book with phone numbers.

## Findings

### High

**H1. POST /contacts turns omitted is_mutual/is_bot into explicit NULL and the whole batch fails**
- Severity: high
- Type: bug
- Area: worker (also found by data+infra; merged)
- Location: worker/src/index.ts:622-623
- Problem: POST /contacts maps an omitted or null `is_mutual`/`is_bot` to an explicit SQL NULL, which defeats the columns' `NOT NULL DEFAULT 0` and makes the single INSERT fail, so every contact in the batch is lost with a 500.
- Evidence: index.ts:622-623 binds `c.is_mutual ?? null` / `c.is_bot ?? null` into an UNNEST insert (index.ts:599) whose column list explicitly names both fields (596-600), and schema.sql:70-71 declares them `SMALLINT NOT NULL DEFAULT 0`; a Postgres default never applies to an explicit NULL, so any new row violates NOT NULL and the catch at 625-628 returns 500 for the whole statement, while ON CONFLICT DO UPDATE (601) only rescues rows that already exist. The repo's own listener triggers it: gramjs/src/listener.ts:274-291 posts `{tg_user_id, username, first_name, last_name}` with no is_mutual/is_bot for every newly-seen sender (fired per NewMessage at listener.ts:753), and `seenSenderIds` only updates on `res.ok` (listener.ts:291), so the same failing POST retries forever. openapi.yaml:148-155 declares both fields nullable, so contract-following clients hit it too. The bulk sync (listener.ts:242-243) and the self-entry (707-708) always send 0/1, which is why the owner's own deployment mostly masks it; scripts/e2e-verify.sh:291 also omits is_mutual and expects 200.
- Verification: verified (fact-checked end to end from source; the fact-check notes it affects all newly-seen senders, not just non-contacts; the issue #87 attribution comes from the open GitHub issue and was not re-fetched)
- Smallest fix: bind `c.is_mutual ?? 0` / `c.is_bot ?? 0` (issue #87's own suggested fix) so the payload contract and the schema agree.

**H2. /ingest and /contacts do not dedupe their batches, and one duplicate key aborts the whole statement**
- Severity: high
- Type: bug
- Area: worker (also found by data+infra; merged)
- Location: worker/src/index.ts:238-259
- Problem: Neither /ingest nor POST /contacts dedupes its batch before the UNNEST ... ON CONFLICT DO UPDATE insert, and a duplicate `(account_id, tg_chat_id, tg_message_id)` or `(account_id, tg_user_id)` inside one request makes Postgres abort the whole statement ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so nothing is written and no acknowledgment is returned.
- Evidence: handleIngest validates field types only (index.ts:170-175) and maps msgs 1:1 into the UNNEST binds (238-259) of a single INSERT with `ON CONFLICT(account_id, tg_chat_id, tg_message_id) DO UPDATE` (181-232, target at 208); contacts does the same with `cs.map(...)` (615-624) against `ON CONFLICT(account_id, tg_user_id)` (601); the targets are UNIQUE(account_id, tg_chat_id, tg_message_id) (schema.sql:43) and the contacts PK (schema.sql:73); a grep confirms the only Set/dedupe logic in index.ts is `knownSet` (2022) and MASTER_ONLY_TOOLS (3755). Failure returns 500 with the raw PG message (260-264). Duplicates are realistic: the listener's NewMessage and EditedMessage handlers (gramjs/src/listener.ts:749-762) can enqueue the same key inside the 2s flush window (listener.ts:744), and flushBuffer splices only after a 2xx (143-144), so a batch containing a duplicate is resubmitted byte-identical forever; backfill-run.ts:292 itself assumes "duplicates are safely handled by ON CONFLICT", which holds across statements but not within one.
- Verification: verified (fact-checked from source; the Postgres 21000 error and statement atomicity are documented engine behavior, not executed against a live database since live systems were out of scope; the fact-checker noted the gap-recovery-overlap route is weaker than first stated because gap recovery runs at startup before handlers, but the New+Edited route carries the finding)
- Smallest fix: dedupe each batch by its conflict key, last value wins, before building the UNNEST arrays, in both /ingest and /contacts.

**H3. A transient disconnect becomes a permanent silent hole in the archive**
- Severity: high
- Type: stability
- Area: listener
- Location: gramjs/src/listener.ts:791
- Problem: A socket drop that autoReconnect heals within the watchdog window produces a permanent silent gap, because GramJS never replays updates missed while disconnected and persistPts overwrites the pre-gap pts within 60 seconds, so even a later restart's gap recovery starts after the hole.
- Evidence: persistPts saves Telegram's current GetState pts every 60s (listener.ts:791-793, 447-450) and swallows failures during the outage in a bare catch (451-453); runGapRecovery's only call site is process startup (listener.ts:730) and no UpdateConnectionState handler is registered anywhere in listener.ts (grep); the watchdog exits only when GetState probes go stale for over 20 minutes (820-846), so reconnects inside that window keep the process running with missed updates. GramJS does not self-heal: grep for GetDifference in node_modules/telegram/client/updates.js and network/MTProtoSender.js (telegram 2.26.22) returns nothing, and catchUp() is an empty TODO (updates.js:65-67). The repo records a real 9-day silent gap incident at listener.ts:816-819.
- Verification: verified
- Smallest fix: on UpdateConnectionState.connected, compare the saved pts against GetState and run GetDifference on divergence, before persistPts can advance the baseline.

**H4. Buffered messages are permanently lost on any non-graceful exit**
- Severity: high
- Type: bug
- Area: listener
- Location: gramjs/src/listener.ts:860
- Problem: Messages held in the ingest buffer are lost on any non-graceful exit, and even the graceful drain gives up after 4 seconds, because pts has already been persisted past them so a restart's gap recovery starts after the buffered messages.
- Evidence: flushBuffer keeps undelivered messages in the in-memory buffer (slice at listener.ts:128, splice only after `res.ok` at 144, kept on failure at 139-150) and nothing ever writes the buffer to disk; persistPts unconditionally saves the server's current pts every 60s (447-454, 791-793) and runGapRecovery fetches only pts greater than the persisted value (387-389). Exit paths that skip any flush: process.exit(1) at 529, 554, 646, 844 (watchdog) and 875 (fatal main catch); the SIGTERM drain has a 4s deadline then exit(0) (859-865), which discards the buffer exactly during a worker outage, when it is fullest. The buffer is unbounded (declared at 119, pushed at 412 and 738) and gramjs/fly.toml:23-26 sets memory 256mb, so an OOM kill loses it too. Only mitigant: the operator-run backfill tool (gramjs/src/backfill.ts) could re-fetch, but nothing automatic does.
- Verification: verified
- Smallest fix: persist the buffer (or a pending-delivery pts high-water mark) to disk alongside state.json, flush it on every exit path, and extend or retry the SIGTERM drain.

**H5. One poison batch head-of-line blocks all newer messages forever, then the buffer is lost**
- Severity: high
- Type: stability
- Area: listener
- Location: gramjs/src/listener.ts:128
- Problem: flushBuffer retries the same first 100 messages forever with no cap, backoff, or dead-letter, so one batch the worker permanently rejects blocks all newer messages while the unbounded buffer grows on a 256MB machine until the process is killed and the buffer is lost.
- Evidence: listener.ts:128 always takes `buffer.slice(0, 100)`, on `!res.ok` only logs "will retry on next flush" (139-150, splice at 144), and no retry cap, backoff or dead-letter exists in the function; steady-state retry triggers are new incoming messages (enqueue at 736-746, immediate flush at >=100 else a 2s debounce at 744) since gap recovery runs only at startup. The poison-batch trigger is real: /ingest is a single-statement UNNEST upsert (worker/src/index.ts:181-232) that 500s on any DB error (260-263), including the intra-batch duplicate case in H2, and the listener does not dedupe `(tg_chat_id, tg_message_id)` before push (handlers at 749-762, gap-recovery pushes at 408-414). The same review records the is_mutual asymmetry (omitted at 282-289, present in syncContacts at 242), consistent with issue #87 claim 1.
- Verification: verified (the fact-check notes the OOM endpoint is volume-dependent, but the unbounded growth on 256MB and the stall itself are factual)
- Smallest fix: cap the buffer, dedupe on enqueue, and give failed batches a bounded retry with a dead-letter (log-and-skip) so one poison batch cannot block the stream.

**H6. A corrupted or missing state.json silently disables gap recovery and then overwrites the baseline**
- Severity: high
- Type: bug
- Area: listener
- Location: gramjs/src/listener.ts:308
- Problem: loadPtsState returns null on any error, gap recovery then logs "no saved pts, skipping", and main immediately persists the current pts as baseline, permanently discarding everything missed during the downtime; the state write itself is non-atomic.
- Evidence: loadPtsState catches any error, including JSON.parse failure and missing file, and returns null (listener.ts:308-315); runGapRecovery logs and returns (371-374); main then calls persistPts with the current GetState pts (730-731, 447-454). savePtsState writes STATE_FILE directly with no tmp+rename (317-323), so a crash or OOM mid-write can itself create the corrupt file, and a failed save is only logged (320-322) while pts quietly goes stale until DifferenceTooLong discards the whole gap (391-396). gramjs/fly.toml:16-19 confirms /data/state.json is a persistent volume, so the corrupted-state path is reachable and load-bearing, and listener.ts:817-820 records the real 9-day gap incident.
- Verification: verified ("permanently discarding" holds for the automatic path; the manual backfill.ts could still recover the messages if a human runs it)
- Smallest fix: write state.json atomically (tmp file plus rename) and, on load failure, recover from a safe default instead of skipping and overwriting.

**H7. Outbox sends are at-least-once with the ack after the send, so duplicates are guaranteed on interruption**
- Severity: high
- Type: bug
- Area: listener (with worker)
- Location: gramjs/src/listener.ts:523
- Problem: The ack happens after the Telegram send with no error handling on the ack and no sent-id tracking on either side, so a crash or failed ack between send and ack produces a duplicate send after the worker's 5-minute stuck reset re-claims the item.
- Evidence: listener.ts:522-523 awaits `client.sendMessage` then awaits `ackOutbox`; ackOutbox (487-499) is a bare `await fetch` with no try/catch and no `res.ok` check; the worker marks the item 'sending' at claim (worker/src/index.ts:1413-1415), only the ack moves it out (1550-1554), and the recovery CTE resets any 'sending' item older than 5 minutes back to 'pending' unconditionally (1398-1404), re-issuing it with no dedupe; a grep across both files found no per-chat sent-id or idempotency tracking anywhere. Fact-check nuance: for the single-chat path an ack rejection is caught at listener.ts:525 and acks the item 'failed' (532), yielding a false 'failed' rather than a duplicate; the duplicate path is the crash window, the silently ignored non-OK ack (e.g. the worker's own 500 at index.ts:1571-1573), and the genuinely unguarded mass-send final ack at listener.ts:567.
- Verification: verified
- Smallest fix: store the sent message id on the outbox item when sendMessage succeeds and make the 5-minute reset skip items that already have one; give ackOutbox res.ok handling with retry.

**H8. Long mass sends get re-claimed and re-sent concurrently**
- Severity: high
- Type: bug
- Area: listener (with worker)
- Location: gramjs/src/listener.ts:566
- Problem: Mass sends hold all recipient results in memory and ack once at the end, so any send loop longer than the worker's 5-minute stuck threshold is re-claimed and re-sent concurrently by the next poll tick, and pollOutbox has no re-entrancy guard.
- Evidence: per-recipient results accumulate in a local array (listener.ts:539, pushed at 548 and 557) with 2-5s jitter between recipients (561-563) and one final ackOutbox POST (566-567), so mid-loop the worker still shows every recipient 'pending' (fetch filter at worker/src/index.ts:1441); after 300s the reset_stuck CTE flips the item back to 'pending' (1398-1404) while reset_stuck_recipients only resets 'failed' recipients (1406-1412), the next 30s tick re-claims it (claim CTEs at 1413-1427), and pollOutbox is a bare setInterval callback (listener.ts:811) whose file's only re-entrancy guard is `let flushing` for flushBuffer (121). The worker's ack handler (1534-1575) is an unconditional UPDATE with no status precondition, so nothing stops the first loop; both loops deliver to the same recipients.
- Verification: verified (the "60+ recipients exceeds 5 minutes" figure is an estimate, but the mechanism triggers for any loop over 300s, which large mass sends plausibly reach)
- Smallest fix: add an "already running" guard to pollOutbox and ack recipients incrementally instead of once at the end, so the worker always sees delivery progress.

**H9. Pending actions have no claim or lease, so forwards and deletes re-execute**
- Severity: high
- Type: bug
- Area: listener (with worker)
- Location: gramjs/src/listener.ts:641
- Problem: The worker returns every status='pending' action and the listener acks only after executing, so a crash or failed ack re-executes the action, and 'forward' is not idempotent.
- Evidence: handleGetActionsPending (worker/src/index.ts:1623-1638) is a plain SELECT with no status transition, a repo-wide grep shows the only UPDATE of pending_actions is the explicit ack (1653), and schema.sql:183-198 has no lease/claim columns ('pending'/'done'/'failed' only); listener.ts:641 acks 'done' only after the Telegram operation succeeds, ackAction (600-606) has no try/catch and does not even check res.ok, so a worker 5xx at ack time silently leaves the row pending and the 30s poll (814) re-executes it; forward (629-638) calls ForwardMessages with a fresh randomId each run, inserting a duplicate copy; the FLOOD_WAIT "retried on restart" exit is at 644-646 as the finding quoted. Fact-check nuance: a network-rejected 'done' ack falls into the catch at 642-649 which retries as 'failed'; re-execution occurs via the ignored-5xx path, both acks failing, or a crash between operation and ack.
- Verification: verified
- Smallest fix: turn GET /actions/pending into a claim (one UPDATE ... SET status='sending' ... RETURNING so each row is handed out exactly once), with the ack setting the final status.

**H10. The audit log (and last_used_at) is written fire-and-forget without waitUntil, so the runtime can drop it**
- Severity: high
- Type: stability
- Area: worker
- Location: worker/src/index.ts:129-133
- Problem: The audit-log INSERT for every MCP send/edit/delete/forward is fired as an unawaited promise with only .catch(), and no request-path code has access to ctx.waitUntil, so the runtime can cancel the write as soon as the response is returned, silently dropping the audit trail; the same pattern drops last_used_at updates in auth.
- Evidence: index.ts:129-133 fires the INSERT unawaited; fetch(request, env) at 3233 drops the ExecutionContext parameter entirely and there is no `cloudflare:workers` import in worker/src (grep); the only waitUntil call in the file is `ctx.waitUntil(runJobs(env))` in scheduled() at 3851; auth.ts:102-105 has the identical pattern for the agent_tokens.last_used_at UPDATE. Cloudflare's documented behavior (checked against cloudflare-docs by the fact-checker) is that a post-response async call that is neither awaited nor passed to waitUntil can be canceled once the invocation ends, and the JSON responses here are non-streamed. checkAndAuditWrite's five call sites (2034, 2041, 2079, 2101, 2144) all sit inside the MCP dispatch, so REST writes (POST /outbox at 2914 inserting at 1333, /actions/* at 2939-2952) are never audited at all, while GET /audit-log (2956) serves the table as if populated.
- Verification: verified (code and Cloudflare docs decide it; not run against a live worker)
- Smallest fix: thread the ExecutionContext into checkAndAuditWrite and the auth update and wrap both writes in ctx.waitUntil; optionally audit the REST write paths too.

**H11. Setup phase C (Telegram auth) always fails on a fresh clone**
- Severity: high
- Type: bug
- Area: data+infra
- Location: scripts/setup.ts:478-495
- Problem: The inline auth helper is written to the repo root, where `require('telegram')` cannot resolve because Node resolves from the script's own directory, not the spawn cwd, so the one credential the whole system depends on can never be captured.
- Evidence: setup.ts:478 writes the helper to `path.join(ROOT, '.setup-auth-helper.cjs')` with ROOT = repo root (setup.ts:68); the `require('telegram')` calls sit at the top of the inline script (432-433), before any Telegram prompt; spawnSync runs it with cwd=gramjs (491-495) while the npm install at 425 puts telegram only in gramjs/node_modules, and root package.json has no telegram, no workspaces, and no root node_modules. The fact-checker reproduced the resolution semantics with a probe tree in /tmp (repo untouched): the root-level helper failed with "Cannot find module telegram", MODULE_NOT_FOUND, exit 1, triggering the throw at setup.ts:500-502, while the identical require from a script inside gramjs/ resolved fine, proving only the script's directory chain matters.
- Verification: verified
- Smallest fix: write the helper into gramjs/ (next to its node_modules), or require telegram by absolute path via createRequire.

**H12. Setup hands the user an MCP URL bound to an empty 'primary' namespace with a green success banner**
- Severity: high
- Type: bug
- Area: data+infra (related low finding from security merged in)
- Location: scripts/setup.ts:884-908
- Problem: Phase G's account-id auto-detection can never see the real numeric Telegram id: it authenticates with the master token against a route that only accepts the ingest token, the 401 is swallowed, and the fallback to 'primary' is baked into the finished MCP connection URL, which queries an account with no messages.
- Evidence: setup.ts:625 and 633 mint INGEST_TOKEN and MASTER_TOKEN independently (set as separate secrets at 666-667), so the /stats call at setup.ts:888 with `X-Ingest-Token: masterToken` 401s against the INGEST_TOKEN-only check (worker/src/auth.ts:35-36, worker/src/index.ts:3282); run() with ignoreError returns '' (211-213), JSON.parse throws, and the catch at 896-901 falls back to 'primary'. Even with the right token it would still fail: no account header is sent, the REST router defaults accountId to 'primary' (index.ts:3248), and /stats exposes my_user_id only for numeric ids (934) with no `account_id` key in the response (935-944), while the listener stores everything under `String(me.id)` (gramjs/src/listener.ts:695); the placeholder is baked into the MCP URL at setup.ts:1009 before the "Setup complete!" banner at 1020.
- Verification: verified (the security area's narrower version of this finding, marked unconfirmed, merged here into the stronger verified evidence)
- Smallest fix: authenticate this call with the ingest token and supply the numeric account id explicitly rather than relying on detection, failing loudly if it cannot be determined.

**H13. DEPLOY.md dead-ends a fresh self-hoster three times**
- Severity: high
- Type: docs
- Area: data+infra
- Location: DEPLOY.md:34-48
- Problem: The manual deploy doc creates a Fly app whose global name is already the owner's live app, verifies with a query on the dropped `direction` column, and never sets the required MASTER_TOKEN secret.
- Evidence: DEPLOY.md:38 hardcodes `fly apps create tg-reader`, which is the owner's app (gramjs/fly.toml:8 `app = "tg-reader"`, deployed by .github/workflows/deploy-gramjs.yml:15); DEPLOY.md:59-60 selects `direction`, a column absent from schema.sql (full read, grep zero hits; removal commit 58e564a verified in history; SPEC.md:228 states it was removed), so the documented check deterministically fails on a schema-built database; step 2 sets only INGEST_TOKEN and DATABASE_URL (DEPLOY.md:18-19, MASTER_TOKEN appears nowhere in the file) while worker/src/types.ts:35 requires it (sole consumer worker/src/auth.ts:66) and agent tokens cannot be created without it (worker/src/index.ts:2197-2208). Fact-check correction with identical net impact: an undefined MASTER_TOKEN yields 401, not a 500 (the timing-safe compare's length guard returns false at auth.ts:16, the agent-token fallback finds zero tokens and returns 401 at auth.ts:89-93, returned as-is at index.ts:3270-3277). The doc also still assumes psql (10, 59, 74) which setup.ts replaced with a pg client (575-589).
- Verification: verified (Fly's global name uniqueness is a platform fact not checkable without live access; the collision with the owner's own app is certain from the repo)
- Smallest fix: rewrite DEPLOY.md with a placeholder app name, a verify query matching the current schema, and a MASTER_TOKEN secret step, or point it at scripts/setup.ts which handles all three.

**H14. The dashboard cannot be served by any deploy of this tree, while the docs claim it can**
- Severity: high
- Type: bug
- Area: worker + dashboard+cli (also part of a data+infra finding; merged)
- Location: worker/wrangler.toml:1-14 (with frontend/vite.config.ts:8-10)
- Problem: wrangler.toml has no [assets] section, no code path serves static files, worker/public is gitignored, and CI never builds the frontend, so the deployed Worker can never serve the UI, while docs/setup.md tells self-hosters the exact opposite.
- Evidence: wrangler.toml (read in full) contains only name/main/compatibility_date, [[r2_buckets]], [ai], [triggers]; grep for ASSETS/public/assets across worker/src and wrangler.toml returns nothing, and fetch() (worker/src/index.ts:3233-3286) routes only /mcp and API paths, falling through to the 404 JSON at 3221 (an unauthenticated browser GET / actually hits the auth check at 3282-3283 and gets 401; with a token, the 404). frontend/vite.config.ts:8-10 outputs to '../worker/public', .gitignore:7 ignores 'worker/public/' (git check-ignore and git ls-files verified: zero tracked files, so a fresh clone has no public/), and .github/workflows/deploy-worker.yml runs only npm install plus `npx wrangler deploy` with no frontend build. docs/setup.md:205 states "The Worker's wrangler.toml already has [assets] directory = \"./public\" configured" and lines 200-202 claim static files deploy automatically, both false against the current tree, so neither the CI path nor the documented manual build+deploy can serve anything. This directly blocks issue #83. Found independently by the worker and dashboard+cli areas and merged.
- Verification: verified
- Smallest fix: add an [assets] block pointing at the built frontend to wrangler.toml and build the frontend in deploy-worker.yml before the deploy step; correct docs/setup.md:200-205.

**H15. Opening a chat shows its oldest 50 messages, and "load older" pages toward the present**
- Severity: high
- Type: bug
- Area: dashboard+cli
- Location: frontend/src/screens/ChatView.tsx:139-168 (with worker/src/index.ts:508-547)
- Problem: GET /history orders ascending from the start of the chat with no backward cursor, so the initial view is the oldest ~50 messages, the button labeled "load older" actually fetches chronologically newer pages, and there is no way to reach the latest messages.
- Evidence: the initial fetch sends only `{chat_id, limit: 50}` (ChatView.tsx:140) against a handler that orders `m.sent_at ASC, m.id ASC` (worker/src/index.ts:537) with a forward keyset `m.sent_at > $3` (520, parsed at 514-515, next cursor returned at 544, 547-548); the button passes after_id/after_sent_at (ChatView.tsx:160) and no other cursor parsing exists in handleHistory, so there is no jump-to-latest. Fact-check mechanism correction: the code appends rather than prepends (ChatView.tsx:162 is `[...prev, ...r.messages]`) and the displayed list stays chronological, so the real symptom is a mislabeled button and no way to the recent end, not mixed ordering.
- Verification: verified (from code; the UI was not run against a live worker)
- Smallest fix: serve history newest-first with a before_id/before_sent_at backward keyset (mirroring /search) and let the client reverse each page, so the first screen shows recent messages and the button pages backward honestly.

### Medium

**M1. The daily backup cron swallows every failure, and the prune lists only one R2 page**
- Severity: medium
- Type: stability
- Area: worker
- Location: worker/src/index.ts:3363-3365
- Problem: A Neon or R2 failure mid-stream silently skips that day's backup with no alert, no retry, and a successful cron status, and the monthly storage path has the same swallow-all pattern while the 30-day prune reads only the first list page.
- Evidence: runBackup wraps stream, R2 put (3338-3340), 30-day prune (3345-3351) and audit prune (3355-3361) in try/catch ending `catch (err) { console.error('[backup] failed', err); }` (3363-3365) with no rethrow; runStorageCheck has the identical swallow (3393-3395); scheduled() merely awaits runBackup (3847) so the cron invocation always "succeeds"; a Neon error hits `controller.error(err)` (3333), rejecting the put and leaving that day's `backup-YYYY-MM-DD.ndjson` absent; the prune lists one page (`env.BACKUP_BUCKET.list({ prefix: 'backup-' })`, 3346) with no cursor loop, so objects past the default 1000-object page are never deleted; wrangler.toml has no observability section, so console output is the sole failure signal.
- Verification: verified
- Smallest fix: rethrow from runBackup so the cron fails visibly, enable Workers observability in wrangler.toml, and loop the list with the returned cursor until truncated.

**M2. jobs.schedule is stored but ignored, so "daily" jobs run roughly hourly**
- Severity: medium
- Type: bug
- Area: worker
- Location: worker/src/index.ts:3447-3450
- Problem: The due-jobs filter gates only on the cooldown, never on j.schedule, so a job with schedule '0 3 * * *' actually runs whenever the 15-minute cron tick finds the cooldown elapsed, roughly hourly with the default cooldown.
- Evidence: getDueJobs selects j.schedule (3435) but its WHERE gates only on enabled/token_id/cooldown (3447-3450); the only cron logic in the file is the fixed '*/15 * * * *' trigger (3839, 3850-3851, matching wrangler.toml) and no cron parser exists anywhere in the run path (runJobs 3811-3834, buildContext checks only trigger_type at 3487); create_job requires "at least one of schedule or trigger_type" (2442) and schema.sql:279-280 documents schedule as a trigger, so the schema implies gating; the sole disclosure is inside the MCP tool description, which says schedule is "stored for reference only" and that cron evaluation is not yet implemented (worker/src/mcp-tools.ts:300), while the REST POST /jobs endpoint (3002-3052) accepts schedule with no disclosure at all. Fact-check nits: the schema path is at the repo root, not worker/schema.sql, and the real cadence with a 3600s cooldown is about 75 minutes, still hourly.
- Verification: verified
- Smallest fix: evaluate j.schedule in getDueJobs (or drop the field and require triggers until cron parsing exists), and disclose the behavior on the REST endpoint either way.

**M3. The dashboard's landing endpoints aggregate the whole message table on every call**
- Severity: medium
- Type: stability
- Area: worker
- Location: worker/src/index.ts:857-880
- Problem: GET /chats aggregates every message row for the account (GROUP BY over all rows) on every call with no caching, and /stats, /accounts and the contacts list run comparable full scans just as often from the dashboard's landing path.
- Evidence: handleChats does `WHERE account_id = $1 ... GROUP BY m.tg_chat_id` with HAVING over two MAX(CASE...) aggregates (857-880) with offset pagination recomputing the whole aggregate per page (844; frontend/src/screens/Chats.tsx:36 re-sends offset); handleStats runs COUNT(*), COUNT(DISTINCT tg_chat_id) and SUM(CASE...) over all rows (904-914); /accounts (2846-2855) is a SELECT DISTINCT over messages LEFT JOIN contacts with no WHERE and no try/catch; handleGetContacts evaluates its LATERAL COUNT(*) per matching contact before LIMIT/OFFSET (646-668) because ORDER BY last_seen needs the computed value. The frontend fetches /accounts on every authed mount (app.tsx:24) and /stats on the default screen (Overview.tsx:13); grep found no caching anywhere. Positive side confirmed: search and backup use keyset cursors with the matching covering index idx_account_sent_id (schema.sql:111) and all list endpoints cap limit (200/100/200/200/200 at index.ts:326, 513, 639, 843, 1369). Caveats: the 640k row figure exists only as a code comment (645) and no EXPLAIN was possible, but either way the aggregate input is every message row of the account, since idx_chat_time lacks the selected columns.
- Verification: verified
- Smallest fix: add a small cached or incrementally maintained summary for /stats and /chats (or a short-TTL cache), and give /accounts the standard try/catch.

**M4. Five routes have no try/catch, and POST /outbox skips recipient validation**
- Severity: medium
- Type: stability
- Area: worker
- Location: worker/src/index.ts:2847-2855
- Problem: When Neon is slow or down, five routes throw out of fetch() as an opaque runtime 500 with no CORS headers instead of the consistent `{ok:false,error:'DB error'}` JSON every other endpoint returns, and POST /outbox maps recipients without checking tg_chat_id, which can 500 the request after the outbox row was already committed.
- Evidence: bare `await sql(...)` in /accounts (2846-2855), /audit-log (2956-2978), GET /jobs (2980-3001), POST /jobs (3003-3049) and /jobs/:name/toggle (3175-3189); nothing catches downstream: fetch() calls route() bare at 3285 and the export at 3861 is a plain `{ fetch, scheduled }`, while a grep shows the other 32 handlers return the standard JSON 500. Separately, handlePostOutbox maps recipients with `r.tg_chat_id as string` and no presence check (1346-1350) into outbox_recipients.tg_chat_id, which is NOT NULL (schema.sql:162); the outbox row commits first (1332-1337, no transaction) and a null recipient fails the recipients insert into the 500 catch (1357-1359), leaving an orphaned outbox row, while the MCP send tool explicitly rejects such recipients (2009-2013).
- Verification: verified
- Smallest fix: wrap the five handlers in the standard try/catch, and validate tg_chat_id per recipient before inserting the outbox row (or wrap both inserts in a transaction).

**M5. CI gates nothing, and main's type-check is red right now**
- Severity: medium
- Type: maintenance
- Area: worker + data+infra (merged)
- Location: .github/workflows/deploy-worker.yml:18-20 (with worker/src/index.ts:2589)
- Problem: Production deploys run install+deploy only, and the project's own type-check currently fails on main (one unused variable), so every future type error would ship straight to production unnoticed.
- Evidence: deploy-worker.yml:18-20 is exactly `npm install` plus `npx wrangler deploy` (deploy-gramjs.yml likewise bare flyctl deploys at 15 and 25); `npm --prefix worker run type-check` fails on clean main with `src/index.ts(2589,13): error TS6133: 'model' is declared but its value is never read`, and index.ts:2589 declares `model` whose returned insight object omits it (2624-2636); wrangler's esbuild strips types without checking them, so the deploy succeeds; grep found no check step in any other workflow, no test files, and no test script in any package.json. Adjacent doc mismatch from the same review: mcp-tools.ts:372 says generate_insight calls the LLM and stores the result, while the handler only returns messages for an external caller to upsert (2622-2624). Found by the worker and data+infra areas; the data+infra reviewer rated the bundle high because it included the dashboard gap (now H14), the worker-area fact-check rated the type-check/process gap itself medium, which is what remains after the merge.
- Verification: verified (the fact-checker re-ran the type-check: exit 2 with the exact error above)
- Smallest fix: delete the unused variable (one line) and add type-check plus the frontend build to deploy-worker.yml before the deploy step.

**M6. e2e-verify.sh no longer matches the Worker API, so the post-deploy gate fails on a correct deploy**
- Severity: medium
- Type: bug
- Area: data+infra
- Location: scripts/e2e-verify.sh:91-107
- Problem: The script sends tg_message_id as a JSON number (now required to be a string), greps for an `inserted` field the Worker never returns, sends the removed `direction` field, and omits is_mutual, so DEPLOY.md's "all green" gate fails on a correct fresh deploy.
- Evidence: lines 91-99 and 112-124 emit `TEST_MSG_ID=$((RANDOM + 90000))` (line 85) as a JSON number, while worker/src/index.ts:172-173 requires `typeof m.tg_message_id === 'string'` and 400s otherwise; the greps at 103 and 127 expect '"inserted"' but the handler returns `{ written, noop }` (index.ts:266-269); lines 96 and 120 send `direction`, absent from all of worker/src (grep); line 291 omits is_mutual and expects 200 at 293, tripping the H1 500. DEPLOY.md:53 and E2E.md:19-23 direct users to run this script as the gate, and FAIL>0 exits 1 (311-313).
- Verification: verified
- Smallest fix: quote tg_message_id, expect written/noop, drop direction, send is_mutual 0, and re-run the script against a real deploy once fixed.

**M7. The GramJS deploy workflow hardcodes the owner's app names and a personal handle**
- Severity: medium
- Type: maintenance
- Area: data+infra
- Location: .github/workflows/deploy-gramjs.yml:10-28
- Problem: Both deploy jobs hardcode the owner's two Fly app names and distinct token secrets, and the job name leaks a personal handle, so a stranger cannot use CI without editing the workflow and a naive fork-and-push deploys nothing.
- Evidence: line 10 names the job 'deploy-madhoneycub', line 15 runs `flyctl deploy --app tg-reader --remote-only` with secrets.FLY_API_TOKEN, line 25 runs `--app tg-reader-main` with secrets.FLY_API_TOKEN_MAIN; the 29-line workflow has a push trigger only, no inputs, vars or env, and setup.ts rewrites only gramjs/fly.toml (766), never the workflow; gramjs/src/backfill-run.ts:481 also hardcodes both app names in its AUTH_KEY_DUPLICATED advice.
- Verification: verified (whether 'madhoneycub' is the owner's Fly org name is unverified locally; it appears nowhere else in the repo, so the wording is a nuance only)
- Smallest fix: parameterize the app names via repository variables (skipping cleanly when unset) and rename the job; have setup.ts rewrite these too.

**M8. Setup never provisions the R2 bucket the Worker config requires**
- Severity: medium
- Type: bug
- Area: data+infra
- Location: scripts/setup.ts:640-712
- Problem: The setup script creates and renames the Worker but never creates the tg-reader-backup R2 bucket that wrangler.toml binds, and neither does DEPLOY.md, so a fresh user's daily backup cron writes to a bucket that does not exist.
- Evidence: worker/wrangler.toml:5-7 binds `bucket_name = "tg-reader-backup"` and wrangler.toml:13-14 schedules the daily backup, which calls `env.BACKUP_BUCKET.put` at worker/src/index.ts:3338 via the cron routed at 3846; grep for r2/bucket in scripts/setup.ts returns nothing, phase E goes straight from the Worker name rewrite (640-654) to `npx wrangler deploy` (692), and a repo-wide grep for bucket provisioning across *.md found nothing either; docs/setup.md:7 does tell the user the Workers Paid plan is a prerequisite, but only outside the script.
- Verification: verified (the exact wrangler deploy-time behavior for a missing bucket is unverified, since no live deploy was allowed; the 03:00 UTC cron definitively targets a nonexistent bucket on a fresh install)
- Smallest fix: have phase E run `npx wrangler r2 bucket create` with the same sanitized naming it already applies elsewhere, or fail with that instruction.

**M9. MIGRATION.md describes a migration that shipped differently and still shows every task pending**
- Severity: medium
- Type: docs
- Area: data+infra
- Location: MIGRATION.md:25-99
- Problem: The doc prescribes nodejs_compat, a Hyperdrive binding and `new Pool(...)`, while the shipped code uses the neon() HTTP driver with a DATABASE_URL secret, and all seven tasks still show as unchecked pending.
- Evidence: MIGRATION.md:29 compatibility_flags, 30-35 the [[hyperdrive]] block, 52 `HYPERDRIVE: Hyperdrive`, 97 `new Pool({ connectionString: env.HYPERDRIVE.connectionString })`, 13-19 all tasks '[ ]' under the pending/done legend at 5-7; actual code is helpers.ts:20-22 `return neon(env.DATABASE_URL)` and types.ts:31-37 with no HYPERDRIVE; a full read of wrangler.toml plus a repo grep found neither nodejs_compat nor hyperdrive anywhere; git shows 58929a9 executed the migration as written and efd9538 replaced it with the neon driver and removed the binding, and MIGRATION.md was never updated (grep found zero references to the file repo-wide).
- Verification: verified
- Smallest fix: mark the migration done and rewrite the page to describe the shipped neon() setup, or archive it with a historical note.

**M10. Dependabot watches only a package.json with no runtime dependencies**
- Severity: medium
- Type: maintenance
- Area: data+infra
- Location: .github/dependabot.yml:7-10
- Problem: The single npm entry points at the root package.json, which contains no runtime dependencies, so the four packages that actually run, including the MTProto library holding the authenticated Telegram session, get no update PRs.
- Evidence: dependabot.yml:7-10 is the only config in the repo and points at directory "/"; root package.json (read in full) has only devDependencies (@types/node, @types/pg, pg, tsx) and no workspaces; worker/, gramjs/, frontend/ and cli/ each hold real runtime dependencies and their own package-lock.json (all four verified present), with the locked versions confirmed in the lockfiles: telegram 2.26.22, @neondatabase/serverless 0.10.4, wrangler 3.114.17, vite 5.4.21, preact 10.29.0.
- Verification: verified
- Smallest fix: add one Dependabot entry per package directory (worker, gramjs, frontend, cli).

**M11. Setup contradicts its own secret-handling policy in three places**
- Severity: medium
- Type: security
- Area: data+infra (related low finding from security merged in)
- Location: scripts/setup.ts:887-940
- Problem: MASTER_TOKEN is interpolated onto curl command lines visible in the local process list after the script explicitly pipes other secrets via stdin to avoid exactly that, a failed agent-token extraction still prints success, and API_HASH is read with an echoing prompt while the masking helper sits unused.
- Evidence: the stdin-piping policy comment is at 673-675 ("avoids exposing the value via ps, shell history"), yet 887-890, 935-942 and 973-980 pass `${masterToken}` inside `sh -c` command strings (run() at 196-216 spawnSyncs sh -c); the failure path at 993-998 stores '(create-manually)' and 1002 still prints "MCP agent token created [redacted]"; API_HASH is read via plain ask() at 376 while askSecret (127-161) has zero call sites (grep: only the definition). Mitigations verified: state file chmod 0600 (92-94), plaintext disclosure (1034-1035), gitignored (.gitignore:10 plus auto-append at 1095-1103).
- Verification: verified (spawnSync sh -c does not write to the interactive shell history, so the practical exposure is ps visibility during the curl calls; a seconds-long local exposure of the highest-privilege token)
- Smallest fix: pass Authorization headers via curl's `-H @-` stdin form or a small node fetch, use askSecret for API_HASH, and print failure honestly when extraction fails.

**M12. The MCP address_book/contacts and stats tools apply no read scope**
- Severity: medium
- Type: security
- Area: worker + security (merged; worker rated high, security fact-check weighed severity and concluded medium)
- Location: worker/src/index.ts:1809-1847
- Problem: The address_book/contacts tool filters only on account and search, so a whitelist/blacklist-scoped read-only agent token can enumerate every saved contact including phone numbers and usernames, and the stats tool leaks account-wide aggregates the same way, contradicting the scoping deliberately added to the senders tool for exactly this leak.
- Evidence: the address_book/contacts branch selects c.phone (1820) filtering only on account_id, search and a has_messages HAVING (1830-1833), with no buildReadScopeClause anywhere in the block; ctx.role is in scope and applied by every sibling read tool (search 1722, chats 1750, history 1771, digest 1878, and senders, whose comment at 714-716 states the exact leak rationale and which applies the clause at 718); grep shows all buildReadScopeClause call sites, none here. The tool is absent from MASTER_ONLY_TOOLS (3755-3759), visible via the tools/list filter (2752-2754) with no gate at tools/call (2762-2779) or at dispatch entry (1694-1702), and the scheduled-job loop dispatches the same non-master-only set with a scoped role (3760, 3763, 3802); stats (1865-1869) delegates to handleStats (903) which takes no role and returns account-wide aggregates including total_contacts and my_user_id. Auth coverage otherwise checked: OPTIONS preflight is the only bypass (3234-3237), non-/mcp routes require the timing-safe INGEST_TOKEN (auth.ts:34-40), /mcp accepts the master token or hashed expiring agent tokens (auth.ts:66-123), ?token= is /mcp-only with a deprecation warning (auth.ts:61-63) and a README caveat (README.md:128-132).
- Verification: verified (severity: the security fact-check concluded medium because it requires a valid agent token and leaks contact metadata rather than message content; the worker reviewer had suggested high, recorded here for transparency)
- Smallest fix: the scope clause filters tg_chat_id, which contact rows lack, so a drop-in clause does not fit: restrict address_book/contacts and stats to MASTER_ONLY_TOOLS, or add a contacts-specific scope filter.

**M13. MCP outbox_status lets any scoped token read every draft and queued send by walking sequential ids**
- Severity: medium
- Type: security
- Area: security
- Location: worker/src/index.ts:2159-2169
- Problem: The outbox_status query has no role check, no read scope, and no ownership filter, so any scoped read-only agent token can iterate the sequential outbox id and read the full text of every draft and queued send, including drafts created by the owner or other tokens.
- Evidence: the handler selects `id, tg_chat_id, text, status, ...` WHERE account_id = $1 AND id = $2 and returns rows[0] raw (no truncateText, unlike every other MCP read path); ids are sequential (`BIGINT GENERATED ALWAYS AS IDENTITY`, schema.sql:135; RETURNING id at index.ts:1332-1338); the draft tool deliberately skips write/permission checks ("drafts are not writes until promoted", 2030-2031) so drafts exist from the owner via the INGEST_TOKEN-only POST /outbox (2914-2915) and from any token; MASTER_ONLY_TOOLS (3755-3759) does not cover outbox_status, authenticateMcp imposes no capability check (auth.ts:48-124), and tools/call dispatches straight to dispatchMcpTool (2762-2783); every other read tool applies scope (368, 433, 718, 853, 1771, 1878, 1949), making outbox_status the sole agent-token-readable outbox path (GET /outbox is INGEST_TOKEN-only, 2917-2918).
- Verification: verified
- Smallest fix: gate outbox_status behind the master token, or add a creator/token ownership filter and apply read scope to the target chat.

**M14. Observer-job prompts embed untrusted chat text and can steer the model into sending from the owner's account**
- Severity: medium
- Type: security
- Area: security
- Location: worker/src/index.ts:3539-3559 and 3762-3808
- Problem: Trigger-driven jobs interpolate untrusted Telegram message text into the LLM prompt and let the model drive the send tool with the job's role, so any chat participant can plant instructions that make the account send messages, and the job path has no human confirmation step.
- Evidence: buildContext interpolates `trigMsg.text.slice(0,300)` via <message_snippet> tags plus {sender}/{chat_name} (3551-3559); runAgentLoop makes that the sole user message with no system prompt (3762-3764) and dispatches the model's tool calls (3802); JOB_TOOL_DEFINITIONS excludes only management tools (3754-3760), so send/draft/edit_message/delete_message/forward_message are all offered (mcp-tools.ts:110, 125, 139, 152, 164); POST /jobs auto-creates role 'job-default' with read_mode='all' and can_send=1 (3022-3030), which checkWritePermission allows to any chat (34-96, fall-through at 95); the queued item is then really sent by the listener's 30s poll (gramjs/src/listener.ts:810-811, 572-578, 524). Fact-check corrections that strengthen the finding: the "confirm before sending" instruction exists only in the MCP initialize response (2720) and is never shown to the job agent (callModel sends only messages+tools, 3644-3731), and by default only 'send' executes since can_edit/can_delete/can_forward default to 0 (2079, 2101, 2144, 19-32). Mitigations that stand: role scoping, cooldown (3600s default, 3046, 3449, 3562-3564), audit logging, mass-send caps (1989-2027).
- Verification: verified (medium stands: real impact, but it requires an existing trigger-based job using {snippet} and is rate-limited by cooldown)
- Smallest fix: exclude write tools from trigger-driven jobs unless the job explicitly opts in, and pass the snippet as quoted data the model is told never to follow.

**M15. No disconnect handling, and the effective reconnect cap is unbounded, so a dead connection costs about 25 minutes**
- Severity: medium
- Type: stability
- Area: listener
- Location: gramjs/src/listener.ts:680
- Problem: The comment "connectionRetries: 5, exhaust retries, exit, Fly restarts" does not match GramJS: reconnect cycles are capped by reconnectRetries, which is effectively unset here and therefore unbounded, and nothing registers disconnect handlers, so a permanently dead connection is only caught by the 20-minute watchdog.
- Evidence: listener.ts:677-685 sets connectionRetries: 5 and autoReconnect: true with the comment at 680, and grep finds no UpdateConnectionState/Disconnected handler anywhere in gramjs/src; in installed telegram 2.26.22 connectionRetries maps to the per-connect-cycle loop (node_modules/telegram/network/MTProtoSender.js:149) which returns false without throwing, TelegramClient.connect itself returns false on failure (TelegramClient.js:1088-1094), the runtime reconnect cap is _reconnectRetries (MTProtoSender.js:376-382) whose Infinity default is overwritten by the undefined client param (telegramBaseClient.js:84, TelegramClient.js:1076, Object.assign at MTProtoSender.js:43), making the abort branch unreachable; main() parks on `new Promise<never>(() => {})` (listener.ts:870), so only the watchdog ends the process (5-min probe interval at 846, exit at 842-844), roughly 25 minutes worst case. Messages missed this way are healed by restart gap recovery, because persistPts' GetState round-trip cannot succeed during an outage (451-453).
- Verification: verified
- Smallest fix: set an explicit finite reconnectRetries and register connection-state handlers that either trigger the H3 pts check or exit deliberately, instead of relying on the watchdog.

**M16. Gap recovery replays only new messages, so edits and deletes made during downtime are lost forever**
- Severity: medium
- Type: bug
- Area: listener
- Location: gramjs/src/listener.ts:409
- Problem: runGapRecovery reads only result.newMessages and skips everything not an Api.Message, so edits and deletes that happened while the listener was down are never applied and are never re-fetched once pts advances past the gap.
- Evidence: runGapRecovery reads only `result.newMessages` (405) and filters `if (!(raw instanceof Api.Message)) continue;` (409); grep for otherUpdates across gramjs/src returns zero matches, while GetDifference delivers edits and deletes in otherUpdates (the installed events/EditedMessage.js:24-25 and events/DeletedMessage.js:44-47 build from those update types) and the live handlers only see real-time dispatch (758-788); GramJS catchUp() is an empty TODO (node_modules/telegram/client/updates.js:65-67), and pts advances past the gap after recovery (424-435, persistPts at 731), so nothing re-fetches them; the manual gap-fill tool is operator-run and does not restore delete state. Impact anchor: AGENT.md:184 "Deleted messages are soft-deleted (is_deleted=1), not removed".
- Verification: verified
- Smallest fix: feed result.otherUpdates through the same edit/delete handlers used for live traffic.

**M17. A failed accounts fetch traps the app on a bare spinner, and a revoked token keeps a zombie session**
- Severity: medium
- Type: bug
- Area: dashboard+cli
- Location: frontend/src/app.tsx:22-28, 54-56 (with frontend/src/api.ts:42-46)
- Problem: A transient failure of fetchAccounts after login leaves the whole app on a bare spinner forever with no sidebar and no logout button (the catch is swallowed), and req() never handles 401, so an expired or rotated token keeps a session where every screen just prints "Unauthorized".
- Evidence: Login stores auth with accountId:'' (frontend/src/screens/Login.tsx:14); app.tsx:22-28 fetches accounts exactly once (effect deps [authed]) and swallows any failure with `.catch(() => {})`, so switchAccount never runs and app.tsx:54-56 early-returns the spinner div, with the Sidebar and its logout button (app.tsx:70) unreachable below that return; api.ts:42-45 throws a generic Error with no status handling, and clearAuth is only called from onLogout (app.tsx:40, confirmed by grep); the worker returns 401 for bad, revoked and expired tokens (worker/src/auth.ts:37, 57, 90, 93, 98), which screens print as `> {error}` (Overview.tsx:20).
- Verification: verified (code trace; UI not run live)
- Smallest fix: handle 401 in req() by clearing auth and returning to Login, and render an error state with retry and logout when the initial accounts fetch fails.

**M18. The dashboard can only use the master token, which it stores in sessionStorage with no CSP and no 401 logout**
- Severity: medium
- Type: security
- Area: dashboard+cli
- Location: frontend/src/api.ts:11-15 (with worker/src/auth.ts:22-30)
- Problem: All non-MCP routes compare only against INGEST_TOKEN, so the dashboard must hold the master token, which sits as plain JSON in sessionStorage readable by any script on the page; there is no CSP and no 401 auto-logout, and the master token's surface includes send and token-management endpoints.
- Evidence: every dashboard request sends X-Ingest-Token (api.ts:36-38, 356) and the sole non-MCP gate compares only against env.INGEST_TOKEN (worker/src/auth.ts:36, called once at worker/src/index.ts:3282), while scoped agent tokens validate only in authenticateMcp on /mcp (auth.ts:71-88); the token is stored plain under 'tgr_auth' (api.ts:14); frontend/index.html:3-8 has no CSP meta and none exists anywhere in the repo (grep/find); the only clearAuth() is manual logout (app.tsx:40). The exposure is slightly wider than first stated: the INGEST_TOKEN-gated surface includes POST /outbox and /actions/* (2914, 2939-2948) plus token and role management (3143), so one leaked dashboard token can also mint agent tokens. Mitigating facts: personal single-user deployment, session-scoped storage, and no current HTML-injection sink (grep for dangerouslySetInnerHTML/innerHTML found no hits).
- Verification: verified
- Smallest fix: add 401 handling (ties into M17) and a Content-Security-Policy now; longer term, let the REST surface accept scoped tokens so the browser never holds the master secret.

**M19. Multi-word CLI search queries are silently truncated to the first word**
- Severity: medium
- Type: bug
- Area: dashboard+cli
- Location: cli/tg.ts:312-313
- Problem: `tg search payment invoice` silently searches only for "payment" because cmdSearch takes positional[0] and drops every additional word with no warning.
- Evidence: parseArgs (tg.ts:89-111) pushes every non-flag token into positional (105-106), cmdSearch takes only `args.positional[0]` (312) with no length check, join, or warning, and dispatch at tg.ts:533 passes ParsedArgs unchanged; grep confirmed positional is never joined upstream. Quoted queries still work, matching the finding's "unquoted" wording.
- Verification: verified
- Smallest fix: join the remaining positional tokens into the query, or reject with a usage hint asking for quotes.

**M20. `tg chats` and `tg contacts` silently show only the first page, and --search filters only that page**
- Severity: medium
- Type: bug
- Area: dashboard+cli
- Location: cli/tg.ts:346, 409
- Problem: Both commands send no query params, so they show at most the API's default first page (50 rows, max 200), and `tg contacts --search` filters only that fetched page client-side even though the worker supports a server-side search param, so people and chats beyond row 50 are invisible.
- Evidence: tg.ts:346 and 409 call apiGet with no params, and apiGet (164-174) appends only explicitly passed ones; cmdChats (345-366) and cmdContacts (408-441) fetch once and render with no pagination loop or limit flag; the worker defaults limit to 50 capped at 200 and reads a server-side search param (worker/src/index.ts:638-642, limit at 639, ILIKE applied at 664; handleChats has the same default at 843); tg.ts:411-418 filters the fetched array client-side.
- Verification: verified
- Smallest fix: pass the server-side search param through and loop pages with limit until exhausted (or print the truncation honestly).

**M21. Infinite scroll breaks after a second consecutive full-page search**
- Severity: medium
- Type: bug
- Area: dashboard+cli
- Location: frontend/src/screens/Chats.tsx:47-54 and frontend/src/screens/Contacts.tsx:48-55
- Problem: The sentinel div unmounts during the spinner and remounts when results arrive, but none of the IntersectionObserver effect's dependencies change at that point, so no observer is ever attached to the new element and infinite scroll silently stops.
- Evidence: both components render the sentinel only when `!initialLoading && !searching` (Chats.tsx:69-71, 102; Contacts.tsx:70-72, 112), guard with `if (!sentinelRef.current) return` (48/49) and depend on `[hasMore, loadingMore, offset, query]` (Chats.tsx:54, Contacts.tsx:55); a second full page leaves those deps identical (setHasMore(true) on already-true and setOffset(0) on already-0, Chats.tsx:21/25, Contacts.tsx:22/26, with api.ts:147/151 defining a full page as rows.length === 50), and the fact-checker verified in the installed Preact 10.29.0 hooks source that useEffect queues only when deps change, so nothing re-attaches the observer. Recovery is incidental: a search yielding a short page flips hasMore, or navigating away and back.
- Verification: verified (logic trace plus Preact hooks source; UI not run live)
- Smallest fix: attach the observer via a callback ref on the sentinel (or include `searching` in the effect deps) so a remounted sentinel is always observed.

**M22. The search pagination cursor is sent under the wrong param names, so any caller that paginates repeats page 1 forever**
- Severity: medium
- Type: bug
- Area: dashboard+cli
- Location: frontend/src/api.ts:133-134 (with worker/src/index.ts:328-329)
- Problem: fetchMessages appends the cursor as next_before_id/next_before_sent_at (copied from the response field names), which the worker never reads; it only reads before_id and before_sent_at, so a paginating caller always gets the identical first page.
- Evidence: api.ts:133-134 appends the response field names; handleSearch parses only `p.get('before_sent_at')` / `p.get('before_id')` (index.ts:328-329), a repo-wide grep finds no reader of next_before_id as a query param, and both SQL paths build the keyset clause only when both cursor params are present (358-360, 426-428), otherwise returning the newest limit rows with the same next cursor (487-493). Latent today: Search.tsx:19 calls fetchMessages with no cursor and has no pagination UI, and Overview.tsx:13 likewise; the CLI is unaffected (cli/tg.ts:380 sends the correct `before_id`), and AGENT.md:47 documents the intended contract.
- Verification: verified
- Smallest fix: rename the params in api.ts to before_id/before_sent_at, and either wire up pagination in Search or stop declaring the cursors.

### Low

**L1. openapi.yaml is badly stale versus the router**
- Severity: low
- Type: docs
- Area: worker
- Location: openapi.yaml:178-866
- Problem: The spec omits roughly 17 live route families (history, senders, accounts, the entire outbox family, actions, audit-log, jobs, tokens, roles, insights), documents parameters and response fields that do not match the code, and describes an MCP tool set that no longer exists.
- Evidence: documented paths cover only /ingest, /search, /stats, /chats, /contacts, /config, /chats/config(+/:id), /deleted, /backfill/*, /mcp while the router (worker/src/index.ts:2825-3221) serves far more; /search documents fewer params than the handler accepts (313-323); /stats documents sent_count/received_count which handleStats never returns (935-944); /mcp lists a 'recent' tool that was removed (1862-1864) and a 6-tool set against the real 20+; the auth section claims X-Ingest-Token everywhere while /mcp uses Bearer/master/agent tokens (auth.ts:48-68); "FTS5" is SQLite terminology on a Postgres tsquery; /chats/config documents sync as required while it is optional in code (1049, 1059).
- Verification: unconfirmed (area reviewer's deep read; the fact-check pass did not re-verify this finding)
- Smallest fix: regenerate openapi.yaml from the router in the same pass that adds CI checks, so it stops drifting.

**L2. All API logic lives in one 3,861-line file**
- Severity: low
- Type: maintenance
- Area: worker
- Location: worker/src/index.ts:1-3861
- Problem: The single-file Worker makes review and safe change hard, though it has clear natural seams for a low-risk split into roughly eight modules.
- Evidence: read in full; commented section boundaries already line up with natural modules: entry+router+scheduled (2825-3861), write/audit helpers (10-136), ingest+deleted+backfill (142-1294), reads (287-901), config (952-1083), outbox+pending-actions (1300-1662), MCP dispatch+sessions (1668-2819, with tool schemas and auth already extracted), jobs/AI runner (3402-3834), backup/cron (3292-3396); shared helpers are already imported from helpers.ts.
- Verification: unconfirmed (a judgment call, not a checkable defect)
- Smallest fix: split along the existing seams when touching the file next, after CI runs type-check.

**L3. Small listener-side leftovers (hardcoded personal default, unchecked POST, devDeps in image, loose TLS, session printed)**
- Severity: low
- Type: maintenance
- Area: listener
- Location: gramjs/src/gap-fill.ts:37
- Problem: Assorted small issues: a hardcoded personal GAP_START_TS default, a delete-notification POST that never checks res.ok, devDependencies shipped into the production image, permissive TLS on direct DB scripts, and the session string printed to stdout.
- Evidence: gap-fill.ts:37 defaults GAP_START_TS to '1774871233' (2026-03-30, verified with `date -r`); the DeletedMessage handler POSTs /deleted without checking res.ok (listener.ts:779-784), so failed delete-marking is silent; gramjs Dockerfile:9 runs `npm install` rather than `npm ci --omit=dev`, shipping ts-node/typescript into the runtime image despite package-lock.json existing; enrich-senders.ts:84 and enrich-chat-type.ts:125 connect with `ssl: { rejectUnauthorized: false }`; auth.ts:47-48 prints the full GRAMJS_SESSION to stdout. Premise correction from the same review: production runs compiled JS (Dockerfile:13 `tsc --outDir dist`, Dockerfile:18 and fly.toml:21 `node dist/listener.js`), not ts-node, which is only in local npm scripts.
- Verification: unconfirmed
- Smallest fix: move GAP_START_TS to an env var with no default, check res.ok, switch the Dockerfile to npm ci --omit=dev, and tighten the TLS settings.

**L4. Search shows only the first 50 results and silently downgrades short queries to a recency listing**
- Severity: low
- Type: bug
- Area: dashboard+cli
- Location: frontend/src/screens/Search.tsx:14-31 (with worker/src/index.ts:292-296)
- Problem: The screen shows "N results" but offers no way to see more than the first 50 although the API returns usable cursors, and a query whose tokens are all under 2 characters is silently downgraded by the worker to an unfiltered most-recent listing presented as search results.
- Evidence: Search.tsx:19-21 calls fetchMessages({limit:50}) once with no load-more although api.ts:113-118 declares the cursor fields; the worker drops sub-2-char tokens after sanitizing and falls through to the B-tree recency path (worker/src/index.ts:292-299, 362).
- Verification: unconfirmed
- Smallest fix: add a load-more using the existing cursors and surface a "query too short, showing recent messages" notice when the FTS path is skipped.

**L5. The CLI parses JSON before checking res.ok, masking real HTTP errors**
- Severity: low
- Type: bug
- Area: dashboard+cli
- Location: cli/tg.ts:188-195
- Problem: apiGet awaits res.json() before the !res.ok branch, so a non-JSON failure page (a Cloudflare 5xx HTML page, a proxy block page) throws a SyntaxError and the user sees "Fatal: Unexpected token < in JSON" instead of the HTTP status the code meant to report.
- Evidence: tg.ts:188 `const body = await res.json()` precedes the `if (!res.ok)` branch at 190-193; a parse failure propagates to the generic main().catch at 549-552, losing res.status.
- Verification: unconfirmed
- Smallest fix: check res.ok first and only parse JSON on success.

**L6. `tg init` echoes the token, fixes file mode only at creation, and validates nothing**
- Severity: low
- Type: security/maintenance
- Area: dashboard+cli + security (merged, both unconfirmed)
- Location: cli/tg.ts:41-43, 457-487
- Problem: The ingest token is read with terminal echo (visible in scrollback), ~/.tg-reader.json gets mode 0600 only when first created (an already-existing looser file is never tightened), and init performs no validation probe, so a mistyped URL or token surfaces only on the first real command.
- Evidence: the readline interface uses plain rl.question for the token (tg.ts:458-459, 469-471); saveConfig writes with `{ mode: 0o600 }` and no chmodSync retry (tg.ts:41-43, Node applies mode only on creation); cmdInit (457-487) saves and prints success without calling /accounts, unlike the dashboard's probeAuth (frontend/src/api.ts:354-360); scripts/setup.ts already models both fixes (masked askSecret at 127-161, chmod re-application at 93-95).
- Verification: unconfirmed
- Smallest fix: mask the token prompt, chmodSync after every write, and probe /accounts before declaring init successful.

**L7. The ?token= query-param path puts MCP tokens into logs and URLs**
- Severity: low
- Type: security
- Area: security
- Location: worker/src/auth.ts:54-63 (with worker/src/index.ts:3244)
- Problem: The ?token= fallback for /mcp puts the master or an agent token into Cloudflare access logs, browser history, and the connector URL itself, and only a metadata-only deprecation warning marks it.
- Evidence: fetch() reads url.searchParams.get('token') for /mcp (worker/src/index.ts:3244); authenticateMcp falls back to it when no Authorization header (auth.ts:56) and emits a deprecation warning with no behavior change (61-63); README.md:128-132 documents the claude.ai connector URL with the token in the query string and states it ends up in Cloudflare access logs, so it is a documented trade-off.
- Verification: unconfirmed
- Smallest fix: reject ?token= when the value matches MASTER_TOKEN, forcing scoped, expiring tokens for connector URLs.

## What is already solid

- Keyset pagination is used consistently on the big table: search (before_sent_at+before_id pairs, worker/src/index.ts:328-329), backup streaming (id > lastId in batches of 1000, 3294-3312), and opaque base64 MCP cursors (helpers.ts:96-115), backed by the right covering index idx_account_sent_id (schema.sql:111), so no OFFSET scans on large tables.
- Token handling is genuinely careful: HMAC-sign-then-XOR constant-time comparison for both INGEST_TOKEN and MASTER_TOKEN (worker/src/auth.ts:11-31), agent tokens stored only as SHA-256 hashes with the raw value returned exactly once (index.ts:2358-2383), and no route reachable unauthenticated (only OPTIONS bypasses auth, 3234-3237). Honest caveat: the early length-mismatch return (auth.ts:16) leaks token length, low value since tokens are fixed-hex.
- No escalation path for minted tokens: agent tokens are rejected on all non-MCP routes (worker/src/index.ts:3281-3283), and MASTER-only MCP tools are blocked inside dispatch, not just hidden from tools/list (2201-2209 and 3755-3760); tokens are 256-bit crypto.getRandomValues values (2358-2361, helpers.ts:30-33).
- No SQL injection found in worker/, gramjs/ or scripts/setup.ts: every query is parameterized, all five ILIKE pattern sites escape % _ and backslash (worker/src/index.ts:317, 322, 642, 703, 848, 1813-1815), FTS input is stripped to word characters before to_tsquery (301-311), and dynamic SET clauses are built only from whitelisted column names.
- Read-scope enforcement is plumbed through nearly every data surface a scoped token can touch (worker/src/index.ts:368-371, 433-436, 718, 776, 853, 1771-1773, 1878, 1949-1951, 3535), with one helper (helpers.ts:52-86) keeping whitelist/blacklist semantics in one place; the address_book, stats and outbox_status gaps are reported above as the exceptions.
- The outbox claim is atomic: a single CTE resets stuck 'sending' items older than 5 minutes and claims up to 10 due items in one statement (worker/src/index.ts:1398-1430), so concurrent pollers cannot double-claim.
- Listener buffer semantics are correct: messages stay in the buffer until the worker confirms delivery, retries use slice (never unshift, so no duplicate accumulation from retries), and a flushing flag guards re-entrancy (gramjs/src/listener.ts:119-154).
- The watchdog is thoughtfully built from a real incident: it races a GetState probe against a 30s timeout, attaches probe.catch(() => {}) so a late-rejecting invoke can never become an unhandledRejection, and exits on 20-minute staleness (gramjs/src/listener.ts:820-846).
- Gap recovery is defensively engineered: a 1000-iteration cap, pts-stall detection against infinite loops, per-slice pts persistence, DifferenceTooLong handling, and buffer flushes before every early exit (gramjs/src/listener.ts:385-441).
- backfill-run.ts never advances the pagination cursor until ingest is confirmed, handles MessageEmpty/MessageService page edges that would otherwise loop forever, and enforces randomized anti-ban sleeps everywhere (gramjs/src/backfill-run.ts:155-338, 349-404).
- The frontend api.ts client matches the Worker contract route-by-route (paths, response shapes and fields verified against the handlers for /stats, /history, /chats, /chats/config, /config, /tokens, /roles, /jobs, /audit-log, /insights, /backfill/pending, /accounts); the only mismatch found is the pagination param name in M22; `npx tsc -b` in frontend/ passed.
- XSS-safe rendering throughout: no dangerouslySetInnerHTML or innerHTML anywhere in frontend/src, all message text goes through Preact's escaping, and the UI has zero dependencies beyond preact.
- Token lifecycle UX in the dashboard is thoughtful: a newly created token is shown exactly once with an explicit "cannot be retrieved again" warning and copy button (frontend/src/screens/Tokens.tsx:92-108), revocation uses a two-step confirm (36-45), and the storage choice is documented in-code (api.ts:13).
- The CLI is dependency-free and careful: ANSI-aware column width calculation that strips escape codes (cli/tg.ts:204-246), ISO-or-epoch date parsing with clear "Invalid date" errors (129-135), env-var overrides over the config file, honest empty-state output; `npx tsc --noEmit` in cli/ passed.
- Index coverage genuinely matches the query shapes: the pg_trgm expression index (schema.sql:119-123) matches the ILIKE expression in /search verbatim (worker/src/index.ts:344-347), idx_sender_id (schema.sql:106) serves the per-contact LATERAL stats (660-662), and both partial outbox indexes match the due/claim queries (1420-1441 vs schema.sql:173-177).
- The /ingest upsert semantics are carefully designed for backfill/live interleaving: COALESCE guards so backfill nulls never clobber richer live values, plus the original_text CASE (worker/src/index.ts:208-231).
- The ingest contract is clean about 64-bit safety: Telegram ids are TEXT end to end (schema.sql:14-15, worker/src/types.ts:64-68, listener String() conversions), and git history shows reply_to_message_id was deliberately migrated BIGINT to TEXT (commit 33942df).
- Setup hygiene is mostly right where it counts: user-supplied resource names are sanitized before shell interpolation (scripts/setup.ts:100-108), the state file is 0600 and gitignored (setup.ts:89-95, .gitignore), and temp session/helper files are deleted after use (setup.ts:485-510).
- CORS Access-Control-Allow-Origin:* (helpers.ts:13, index.ts:1669-1672) has no reachable cross-origin violation (no cookies; the token is only in headers/query values an attacker page cannot read), the backup path is cron-only with no HTTP route reaching BACKUP_BUCKET (3841-3855), and gitleaks runs a full-history scan with --redact on all pushes and PRs (.github/workflows/gitleaks.yml:3-23).

## Checked and rejected

- Rejected: "A FLOOD_WAIT over 300s during an outbox send calls process.exit(1) and crash-loops capture for hours" (gramjs/src/listener.ts:529). Reason: the isFloodWait guard matches on the string 'FLOOD_WAIT', but GramJS converts the raw FLOOD_WAIT_X RPC string into FloodWaitError whose message ("A wait of N seconds is required (caused by ...)") contains no such substring; the fact-checker executed the library's own mapper on the installed telegram@2.26.22 (message "A wait of 767 seconds is required (caused by SendMessageRequest)", isFloodWait false), so a real flood wait falls through to acking the item 'failed', which is exactly the correct response; no exit, no crash loop; the floodSleepThreshold premise also applies only to entity resolution, not raw invokes.
- Rejected: "Deploy strategy immediate runs two same-session listeners concurrently, both writing /data/state.json" (gramjs/fly.toml:29). Reason: the machine mounts volume tg_state at /data and a Fly volume attaches to only one machine; strategies that boot machines alongside old ones (canary, bluegreen) are explicitly unusable with attached volumes, and "immediate" is documented only as replacing without waiting for health checks, so the old machine is down before the new one mounts; no concurrent same-session writers exist, and the AUTH_KEY_DUPLICATED warning in backfill-run.ts:480-482 concerns a backfill client versus the running listener.
- Rejected: "Setting chat config Sync back to inherit or clearing the label is silently ignored by the API" (frontend/src/screens/Config.tsx:89-110). Reason: for Sync the UI sends sync:null, which the worker rejects immediately with a visible 400 "sync must be 'include' or 'exclude'" (worker/src/index.ts:1046-1048), so the cited COALESCE path is unreachable for sync and nothing is silent; the label half is real but cosmetic (COALESCE keeps the old label at index.ts:1060 while the UI optimistically shows it cleared until reload), the unused deleteChatConfig was confirmed but the DELETE endpoint itself works, no message data is affected, and 'high' overstated it.

## What this review could not check

- The repo contains no tests: no test script in any package.json and no test files anywhere (verified by the lead reviewer before the run), so nothing was executed end to end.
- Nothing was run against the live Cloudflare Worker, the Fly machines, Neon, R2, or Telegram. In particular, no live Postgres write was made, so the intra-batch ON CONFLICT failure in H2 rests on documented PostgreSQL behavior (SQLSTATE 21000) plus the issue #87 report; the audit-log drop in H10 rests on code plus Cloudflare's documented waitUntil semantics (checked against cloudflare-docs), not a live worker.
- Platform facts not checkable from here: Fly's global app-name uniqueness (H13), the flyctl JSON output parsed at scripts/setup.ts:787-799 (flyctl was not run), wrangler's exact deploy-time behavior with a missing R2 bucket (M8), the deployed production Worker's dashboard settings, and whether 'madhoneycub' is the owner's Fly org name (M7).
- The UI was never run live: ChatView (H15), the infinite-scroll trace (M21), and the spinner/zombie path (M17) are code-only traces; the 640k-row figure exists only as a code comment (worker/src/index.ts:645) and no EXPLAIN was possible against Neon (M3).
- GitHub issues #87 and #83 were not fetched; their content comes from the review brief.
- Findings the fact-check pass did not re-verify, carrying only the area reviewers' own reads (marked unconfirmed above): L1, L2, L3, L4, L5, L6, L7.

## Recommended order of work

1. **Stabilize the real bugs.** Fix issue #87 class first: H1 (default is_mutual/is_bot to 0) and H2 (dedupe batches by conflict key), which together un-wedge ingestion for all clients. Then the listener's silent-loss chain: H3 (gap recovery on reconnect), H4 (persist/flush the buffer on exit), H5 (buffer cap and dead-letter), H6 (atomic state.json with recovery on corrupt). Then the duplicate-send class: H7 (sent-id tracking), H8 (poll re-entrancy guard and incremental acks), H9 (action claims). In the same pass, small diffs: H10 (waitUntil for audit and last_used_at) and the three unscoped MCP tools (M12, M13).
2. **CI and safety nets.** Fix the one-line type error and gate both deploy workflows on type-check plus the frontend build (M5); add the first tests, since none exist; make backup failure loud with observability on and the prune cursor loop fixed (M1); update e2e-verify.sh so the post-deploy gate actually works (M6); point Dependabot at worker, gramjs, frontend and cli (M10).
3. **Improvements.** Finish self-hosting for issue #83: setup phase C module resolution (H11), phase G account detection (H12), R2 bucket provisioning (M8), parameterized deploy workflow (M7), DEPLOY.md rewrite (H13), stale docs (M9, L1), and the dashboard [assets] config if not already done in step 1's H14. Then dependency majors (wrangler 3 to 4, vite 5 to 8, preact 10 to 11, @neondatabase/serverless 0.10 to 1.2, esbuild 0.21 to 0.28, typescript 5.9 to 7.0) behind the new CI gate, plus the remaining low findings as touch-me items.
