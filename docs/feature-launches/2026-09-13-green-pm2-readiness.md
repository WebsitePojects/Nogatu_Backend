# Green PM2 readiness guard

## Scope

The staging PM2 app (`nogatu-mlm-green`) no longer waits on PM2's optional
`ready` handshake. Staging promotion must verify the green listener and the
HTTP `/health` and `/ready` endpoints instead. The blue production app keeps
its existing `wait_ready: true` setting.

## Reason

The green process successfully bound port 5003 but PM2 later marked its workers
errored with exit code 0 and no Node fatal error. Removing the staging-only
handshake dependency avoids treating that lifecycle signal as the deployment
health check. It does not change application startup, database behavior, ports,
or production settings.

## Verification

- `node --check index.js`
- `node --check ecosystem.config.js`
- After deployment: confirm PM2 green is online, port 5003 is listening, and
  both `/health` and `/ready` return HTTP 200 before any traffic switch.
